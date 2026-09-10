import { scrapeCsrSite, renderPageForDiscovery } from './csrScraper';
import type { BrowserProfileName } from './csrScraper';
import { scrapeSsrSite } from './ssrScraper';
import { detectRenderingType, FetchHttpError, fetchHtml } from './detector';
import type { DetectionResult } from './detector';
import { buildComparisonGroups } from './matcher';
import { walkForProducts } from './extractor';
import type { ExtractionStrategyName } from './extractor';
import { normalizeUrl, siteNameFromUrl } from '../utils/sites';
import { detectBlock } from '../utils/block';
import { scoreExtraction } from '../utils/quality';
import type { ExtractionQuality } from '../utils/quality';
import { lookupStrategy, recordFailure, recordSuccess, hostOf } from './strategyCache';
import type { HostStrategy } from './strategyCache';
import { hostRateLimiter } from '../utils/rateLimit';
import { allowedByRobots } from '../utils/robots';
import { AbortedError, throwIfAborted } from '../utils/abort';
import { discoverDealPages } from '../discovery';
import { registrableDomain } from '../utils/sameSite';
import { config } from '../config';
import type {
  DiscoveryReport,
  DiscoveryRequestOptions,
  ScrapedProduct,
  ScrapeMethod,
  ScrapeResult,
  SiteReport,
  SiteStatusEvent,
} from '../types';

const MAX_URLS = config.maxUrls;
const DETECT_CONCURRENCY = config.detect.concurrency;
const SCRAPE_CONCURRENCY = config.scrape.concurrency; // browsers are heavy — keep parallel CSR runs low

/** Server answers that mean "refused", not "absent" — escalate to the browser ladder. */
const BROWSER_WORTHY_STATUSES = new Set([401, 403, 429, 500, 502, 503, 504]);

type StatusSink = (e: SiteStatusEvent) => void;

/** D7.1 — extra knobs for a scrape run. */
export interface ScrapeRequestOptions {
  discovery?: DiscoveryRequestOptions;
  /** One callback per domain as its discovery completes (D7.2 — SSE wires
   *  this to a `discovery` event; the one-shot API just collects them into
   *  ScrapeResult.discovery). */
  onDiscovery?: (report: DiscoveryReport) => void;
}

/** A root target is a bare domain or site root — "go find the deals". A
 *  deep path is an explicit instruction: scraped as given under 'auto'. */
export function isRootTarget(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.pathname === '/' || u.pathname === '') && u.search === '' && u.hash === '';
  } catch {
    return false;
  }
}

/** D7.1 — discount used by the post-filter: the explicit percentage, else
 *  derived from original/deal price when both are present. */
const effectiveDiscountPct = (p: ScrapedProduct): number =>
  p.discountPercentage ??
  (p.originalPrice !== null && p.originalPrice > p.dealPrice && p.dealPrice > 0
    ? (1 - p.dealPrice / p.originalPrice) * 100
    : 0);

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        out[i] = await fn(items[i] as T, i);
      }
    }),
  );
  return out;
}

interface SiteJob {
  url: string;
  site: string;
  t0: number;
  d: DetectionResult;
  blockReason: string | null;
  /** Remembered strategy for this host — a HINT, never a rule (§4.1). */
  cached: HostStrategy | null;
}

/** Everything one attempt at scraping learned, for the cache write. */
interface ScrapeOutcome {
  products: ScrapedProduct[];
  method: ScrapeMethod;
  renderType: 'SSR' | 'CSR';
  quality: ExtractionQuality;
  profile: BrowserProfileName | null;
  extractionStrategy: ExtractionStrategyName | 'network' | null;
  learnedSelector: string | null;
  apiEndpoint: string | null;
  blockReason: string | null;
}

/**
 * Adaptive scraper controller.
 * Phase 0 — consult the per-host strategy cache; a hit starts the run at
 *           the remembered rung and skips detection entirely.
 * Phase 1 — architecture detection for hosts we have no (fresh) memory of.
 * Phase 2 — adaptive scraping with the universal ladder; every outcome is
 *           written back to the cache (except blocks — they say nothing
 *           about strategy correctness).
 */
export async function scrapeUrls(
  rawUrls: string[],
  onStatus: StatusSink = () => {},
  /** Client-disconnect cancellation (Phase 6): aborts fetches, closes
   *  browser contexts, skips queued jobs. Never recorded as a failure. */
  signal?: AbortSignal,
  /** D7 — discovery behaviour + per-domain report stream. */
  opts: ScrapeRequestOptions = {},
): Promise<ScrapeResult> {
  const started = Date.now();
  const urls = [...new Set(rawUrls.map(normalizeUrl).filter((u): u is string => u !== null))].slice(
    0,
    MAX_URLS,
  );
  if (!urls.length) throw new Error('No valid URLs provided.');

  const report: SiteReport[] = [];

  /* ── Phase 0 (D7): deal-page discovery. Bare domains / site roots resolve
   *  to their best verified deal pages BEFORE any scrape job exists; deep
   *  paths are explicit instructions and scrape as given under 'auto'.
   *  One discovery per registrable domain, no matter how many of its URLs
   *  were passed. ── */
  const dOpts = opts.discovery ?? {};
  const mode = dOpts.enabled ?? 'auto';
  const discoveryReports: DiscoveryReport[] = [];
  /** Per-URL provenance + verification leftovers for discovered targets. */
  const metaByUrl = new Map<
    string,
    {
      discoveredFrom: string;
      candidateScore?: number;
      preFetchedHtml?: string;
      renderType?: 'SSR' | 'CSR';
      /** D9 fallback target — products post-filtered to discounted-only. */
      onlyDiscounted?: boolean;
    }
  >();

  let targets = urls;
  if (mode !== 'never') {
    const direct: string[] = [];
    const domains = new Map<string, string>(); // registrable domain → origin root
    for (const url of urls) {
      const discoverHere = mode === 'always' || isRootTarget(url);
      if (!discoverHere) {
        direct.push(url);
        continue;
      }
      // 'always': the explicit path is still an explicit instruction.
      if (mode === 'always') direct.push(url);
      let domain: string | null = null;
      try {
        const u = new URL(url);
        domain = registrableDomain(u.hostname);
        if (domain && !domains.has(domain)) domains.set(domain, `${u.origin}/`);
      } catch {
        /* unreachable — urls are normalized above */
      }
      // localhost / bare IPs have no registrable domain: scrape directly.
      if (!domain && mode !== 'always') direct.push(url);
    }

    if (domains.size) {
      interface Found {
        url: string;
        domain: string;
        score?: number;
        html?: string;
        renderType?: 'SSR' | 'CSR';
        /** D9 fallback target — products post-filtered to discounted-only. */
        onlyDiscounted?: boolean;
      }
      const perDomain = await mapWithConcurrency(
        [...domains.entries()],
        DETECT_CONCURRENCY,
        async ([domain, origin]): Promise<Found[]> => {
          throwIfAborted(signal);
          const site = siteNameFromUrl(origin);
          onStatus({
            url: origin,
            site,
            phase: 'discovering',
            message: `🔎 ${site}: discovering deal pages…`,
          });
          try {
            const outcome = await discoverDealPages(
              origin,
              {
                include: dOpts.include,
                exclude: dOpts.exclude,
                limits: dOpts.maxScrape ? { maxScrape: dOpts.maxScrape } : undefined,
                // Tier 4 (SPA-shell homepages): ONE real browser render,
                // budgeted like a fetch, reusing the scraper's shared
                // browser — never launched for anchor-rich SSR homepages.
                renderPage: (u, sig) => renderPageForDiscovery(u, sig),
                onProgress: (m) =>
                  onStatus({
                    url: origin,
                    site,
                    // Verification lines get their own phase for the UI (D7.2).
                    phase: m.startsWith('🧪') ? 'verifying' : 'discovering',
                    message: m,
                  }),
              },
              signal,
            );
            discoveryReports.push(outcome.report);
            opts.onDiscovery?.(outcome.report);
            if (!outcome.selected.length) {
              // D9's category-listing fallback also found nothing — this is
              // the honest, explicit dead end (not an exception).
              onStatus({
                url: origin,
                site,
                phase: 'error',
                message: `❌ ${site}: no deal pages found`,
              });
              report.push({
                url: origin,
                site,
                renderType: null,
                status: 'error',
                productCount: 0,
                durationMs: outcome.report.durationMs,
                error: 'No deal pages found',
                discoveredFrom: domain,
              });
              return [];
            }
            return outcome.selected.map((c) => ({
              url: c.url,
              domain,
              score: c.finalScore,
              html: outcome.preFetchedHtml.get(c.url),
              renderType: c.verified?.renderType,
              // D9: a category-listing fallback is NOT a deal page — its
              // products are post-filtered to discounted-only below.
              onlyDiscounted: c.evidence.includes('fallback:category-listing'),
            }));
          } catch (e) {
            // Cancellation is not a site failure: no report, no cache tick.
            if (e instanceof AbortedError || signal?.aborted) throw new AbortedError();
            const msg = errMsg(e);
            onStatus({
              url: origin,
              site,
              phase: 'error',
              message: `❌ Discovery failed on ${site}: ${msg}`,
            });
            report.push({
              url: origin,
              site,
              renderType: null,
              status: 'error',
              productCount: 0,
              durationMs: 0,
              error: `Discovery failed: ${msg}`,
              discoveredFrom: domain,
            });
            return [];
          }
        },
      );

      targets = [...direct];
      for (const found of perDomain.flat()) {
        if (!metaByUrl.has(found.url)) {
          metaByUrl.set(found.url, {
            discoveredFrom: found.domain,
            candidateScore: found.score,
            preFetchedHtml: found.html,
            renderType: found.renderType,
            onlyDiscounted: found.onlyDiscounted,
          });
        }
        if (!targets.includes(found.url)) targets.push(found.url);
      }
    }
  }

  // Every domain may legitimately yield zero scrapeable URLs (no deal
  // pages found) — an empty result with the reports, not an exception.
  if (!targets.length) {
    return {
      products: [],
      comparisons: [],
      report,
      totalDurationMs: Date.now() - started,
      ...(discoveryReports.length ? { discovery: discoveryReports } : {}),
    };
  }

  /* ── Phase 1: cache lookup + architecture detection ──────────── */
  const jobs = await mapWithConcurrency(targets, DETECT_CONCURRENCY, async (url): Promise<SiteJob | null> => {
    throwIfAborted(signal);
    const site = siteNameFromUrl(url);
    const t0 = Date.now();

    // Optional courtesy check (RESPECT_ROBOTS=true); ROBOTS_OVERRIDE=true
    // bypasses it consciously. Errs open: unreachable robots = allowed.
    if (config.net.respectRobots && !config.net.robotsOverride) {
      if (!(await allowedByRobots(url))) {
        const msg = 'Disallowed by robots.txt (set ROBOTS_OVERRIDE=true to bypass)';
        report.push({
          url, site, renderType: null, status: 'error',
          productCount: 0, durationMs: Date.now() - t0, error: msg,
        });
        onStatus({ url, site, phase: 'error', message: `🤖 ${site}: ${msg}` });
        return null;
      }
    }

    const cached = lookupStrategy(url);

    if (cached) {
      onStatus({
        url, site, phase: 'detecting',
        message: `🧠 Remembered ${site}: ${cached.method} (best quality ${cached.bestQuality.toFixed(2)}, ${cached.successCount}× confirmed) — skipping detection…`,
      });
      if (cached.method === 'fast-html') {
        try {
          // D7: discovery already fetched this URL — reuse, never refetch.
          const html = metaByUrl.get(url)?.preFetchedHtml ?? (await fetchHtml(url, signal));
          const d: DetectionResult = {
            url, renderType: 'SSR', html, framework: null,
            textLength: html.length, hasPrices: true,
          };
          return { url, site, t0, d, blockReason: detectBlock(html), cached };
        } catch {
          // remembered fast-html fetch failed — fall through to full detection
        }
      } else {
        const d: DetectionResult = {
          url, renderType: 'CSR', html: '', framework: null, textLength: 0, hasPrices: false,
        };
        return { url, site, t0, d, blockReason: null, cached };
      }
    }

    // D7: discovery already fetched + classified this URL — its
    // verification leftovers ARE the detection result (plan efficiency
    // invariant 2: a winner is never fetched twice).
    const preMeta = metaByUrl.get(url);
    if (preMeta?.renderType === 'CSR') {
      onStatus({
        url, site, phase: 'detecting', renderType: 'CSR',
        message: `🧪 ${site}: client-rendered — established during discovery, going straight to Browser…`,
      });
      const d: DetectionResult = {
        url, renderType: 'CSR', html: '', framework: null, textLength: 0, hasPrices: false,
      };
      return { url, site, t0, d, blockReason: null, cached: null };
    }
    if (preMeta?.preFetchedHtml) {
      const html = preMeta.preFetchedHtml;
      onStatus({
        url, site, phase: 'detecting', renderType: 'SSR',
        message: `🧪 ${site}: verified during discovery — reusing fetched HTML`,
      });
      const d: DetectionResult = {
        url, renderType: 'SSR', html, framework: null, textLength: html.length, hasPrices: true,
      };
      return { url, site, t0, d, blockReason: detectBlock(html), cached: null };
    }

    onStatus({ url, site, phase: 'detecting', message: '🔍 Checking architecture…' });
    try {
      const d = await detectRenderingType(url, signal);
      // A fetched page can BE the bot wall (Cloudflare "Just a moment…").
      // Note it now: if the ladder then finds nothing, that's a block,
      // not "site has no deals".
      const blockReason = detectBlock(d.html);
      onStatus({
        url,
        site,
        phase: 'detecting',
        renderType: d.renderType,
        message: blockReason
          ? `🛡️ ${blockReason} — will verify with a real browser`
          : `🧭 ${d.renderType} detected${d.framework ? ` (${d.framework})` : ''}`,
      });
      return { url, site, t0, d, blockReason, cached: null };
    } catch (e) {
      // Cancellation is not a site failure: no report, no cache tick.
      if (e instanceof AbortedError || signal?.aborted) throw new AbortedError();
      const msg = errMsg(e);
      const status = e instanceof FetchHttpError ? e.status : null;
      // Universal anti-block escalation: a server that ANSWERED but refused us
      // (auth wall / WAF / rate limit / 5xx shed) is a browser-ladder job, not
      // a fatal error — a real browser routinely passes where a raw HTTP
      // client can't. Genuine network failures (DNS/refused/timeout) stay
      // fatal: no browser can reach a site that isn't there.
      if (status !== null && BROWSER_WORTHY_STATUSES.has(status)) {
        onStatus({
          url, site, phase: 'detecting',
          message: `🛡️ Blocked at HTTP level (${status}) — going straight to Browser…`,
        });
        const d: DetectionResult = {
          url, renderType: 'CSR', html: '', framework: null, textLength: 0, hasPrices: false,
        };
        return { url, site, t0, d, blockReason: detectBlock('', status), cached: null };
      }
      report.push({
        url, site, renderType: null, status: 'error',
        productCount: 0, durationMs: Date.now() - t0, error: msg,
      });
      onStatus({ url, site, phase: 'error', message: `❌ Detection failed: ${msg}` });
      recordFailure(url);
      return null;
    }
  });

  /* ── Phase 2: adaptive scraping ──────────────────────────────── */
  const scrapable = jobs.filter((x): x is SiteJob => x !== null);

  const productSets = await mapWithConcurrency(scrapable, SCRAPE_CONCURRENCY, async (job) =>
    // Per-host serialization (perHostConcurrency: 1): two URLs on one host
    // must not run two scrapes over it simultaneously.
    hostRateLimiter.runExclusive(hostOf(job.url), async () => {
    // May have queued behind a same-host job for minutes — re-check.
    throwIfAborted(signal);
    const { url, site, t0 } = job;
    let { d, cached } = job;
    let blockReason = job.blockReason;

    try {
      /* ── remembered rung first, when we have one ── */
      if (cached) {
        const attempt = await scrapeRemembered(url, site, d, cached, onStatus, (r) => {
          blockReason ??= r;
        }, signal);
        if (
          attempt.products.length > 0 &&
          !blockReason &&
          attempt.quality.score >= config.quality.escalateBelow
        ) {
          // remembered strategy still works — refresh the entry, done.
          recordSuccess(url, {
            renderType: attempt.renderType,
            method: attempt.method,
            profile: attempt.profile,
            extractionStrategy: attempt.extractionStrategy,
            cardSelector: attempt.learnedSelector ?? cached.cardSelector,
            apiEndpoint: attempt.apiEndpoint ?? cached.apiEndpoint,
            quality: attempt.quality.score,
          });
          return finalize(url, site, t0, d, attempt, null, onStatus, report);
        }
        onStatus({
          url, site, phase: 'scraping',
          message: `🔁 Remembered strategy underperformed (score ${attempt.quality.score.toFixed(2)}) — walking the full ladder…`,
        });
        blockReason = attempt.blockReason ?? blockReason;
        // Stale knowledge is suspect: re-detect from scratch, then let the
        // full ladder decide. Whatever wins overwrites the cache below.
        try {
          d = await detectRenderingType(url, signal);
        } catch {
          /* keep the old detection — the ladder below still works */
        }
        cached = null;
      }

      /* ── the full universal ladder ── */
      const outcome = await scrapeFullLadder(url, site, d, onStatus, blockReason, signal);
      blockReason = outcome.blockReason;

      // Cache write rules (§4.1): blocks never touch the cache; quality
      // clears the bar → success; otherwise a failure tick (evict at 3).
      if (!(outcome.products.length === 0 && blockReason)) {
        if (outcome.products.length > 0 && outcome.quality.score >= config.quality.escalateBelow) {
          recordSuccess(url, {
            renderType: outcome.renderType,
            method: outcome.method,
            profile: outcome.profile,
            extractionStrategy: outcome.extractionStrategy,
            cardSelector: outcome.learnedSelector,
            apiEndpoint: outcome.apiEndpoint,
            quality: outcome.quality.score,
          });
        } else {
          recordFailure(url);
        }
      }
      return finalize(url, site, t0, d, outcome, blockReason, onStatus, report);
    } catch (e) {
      // Cancellation is not a site failure: no report, no cache tick.
      if (e instanceof AbortedError || signal?.aborted) throw new AbortedError();
      const msg = errMsg(e);
      report.push({
        url, site, renderType: d.renderType, status: 'error',
        productCount: 0, durationMs: Date.now() - t0, error: msg,
      });
      onStatus({ url, site, phase: 'error', renderType: d.renderType, message: `❌ ${site}: ${msg}` });
      recordFailure(url);
      return [] as ScrapedProduct[];
    }
    }),
  );

  /* D9 step 2: category-listing fallbacks are NOT deal pages — return only
   * the products that ARE discounted (an explicit discountPercentage at the
   * requested floor, or a struck-through original price). Everything else
   * on the page is just… the catalog. */
  const minDiscFloor = dOpts.minDiscountPercent ?? 0;
  const scraped = productSets.flatMap((set, i) => {
    const job = scrapable[i];
    if (job && metaByUrl.get(job.url)?.onlyDiscounted) {
      return set.filter(
        (p) =>
          p.originalPrice !== null ||
          (p.discountPercentage !== null && p.discountPercentage >= minDiscFloor),
      );
    }
    return set;
  });

  // D7.4: discovery provenance onto every report row discovery produced.
  for (const r of report) {
    const m = metaByUrl.get(r.url);
    if (m) {
      r.discoveredFrom ??= m.discoveredFrom;
      r.candidateScore ??= m.candidateScore;
    }
  }

  // D7.1: explicit minimum-discount post-filter (0/absent = no filtering).
  const minDisc = dOpts.minDiscountPercent;
  const products =
    minDisc != null && minDisc > 0
      ? scraped.filter((p) => effectiveDiscountPct(p) >= minDisc)
      : scraped;

  return {
    products,
    comparisons: buildComparisonGroups(products),
    report,
    totalDurationMs: Date.now() - started,
    ...(discoveryReports.length ? { discovery: discoveryReports } : {}),
  };
}

/**
 * One attempt at the remembered rung. If the host has a learned product API,
 * plain axios tries it BEFORE any browser launches — many sites collapse
 * from rung 2 to rung 1 permanently (§4.2).
 */
async function scrapeRemembered(
  url: string,
  site: string,
  d: DetectionResult,
  cached: HostStrategy,
  onStatus: StatusSink,
  onBlock: (reason: string) => void,
  signal?: AbortSignal,
): Promise<ScrapeOutcome> {
  const extraSelectors = cached.cardSelector ? [cached.cardSelector] : [];
  let apiEndpoint: string | null = null;
  let learnedSelector: string | null = null;
  let profile: BrowserProfileName | null = null;

  // Learned API fast path: JSON over HTTP, no browser at all.
  if (cached.apiEndpoint) {
    onStatus({
      url, site, phase: 'scraping',
      message: `⚡ Trying ${site}'s remembered data API…`,
    });
    try {
      const body: unknown = JSON.parse(await fetchHtml(cached.apiEndpoint, signal));
      const products = walkForProducts(body, url, site);
      if (products.length > 0) {
        return {
          products,
          method: cached.method,
          renderType: cached.renderType,
          quality: scoreExtraction(products, url),
          profile: cached.profile,
          extractionStrategy: 'network',
          learnedSelector: cached.cardSelector,
          apiEndpoint: cached.apiEndpoint,
          blockReason: null,
        };
      }
    } catch {
      /* endpoint moved or walled — fall through to the remembered rung */
    }
  }

  if (cached.method === 'fast-html') {
    const products = await scrapeSsrSite(
      d.html, url, site,
      (message) => onStatus({ url, site, phase: 'scraping', renderType: 'SSR', method: 'fast-html', message }),
      extraSelectors,
      signal,
    );
    return {
      products,
      method: 'fast-html',
      renderType: 'SSR',
      quality: scoreExtraction(products, url, d.html),
      profile: null,
      extractionStrategy: cached.extractionStrategy !== 'network' ? cached.extractionStrategy : null,
      learnedSelector: cached.cardSelector,
      apiEndpoint: null,
      blockReason: null,
    };
  }

  const products = await scrapeCsrSite(
    url, site,
    (message) => onStatus({ url, site, phase: 'scraping', renderType: 'CSR', method: 'browser', message }),
    {
      startAtProfile: cached.profile ?? undefined,
      extraCardSelectors: extraSelectors,
      onProfile: (p) => { profile = p; },
      onBlock,
      onApiEndpoint: (ep) => { apiEndpoint = ep; },
      onLearnedSelector: (sel) => { learnedSelector = sel; },
      signal,
    },
  );
  return {
    products,
    method: profile === 'clean' ? 'browser-clean' : 'browser',
    renderType: 'CSR',
    quality: scoreExtraction(products, url),
    profile: profile ?? cached.profile,
    extractionStrategy: apiEndpoint ? 'network' : cached.extractionStrategy,
    learnedSelector: learnedSelector ?? cached.cardSelector,
    apiEndpoint,
    blockReason: null,
  };
}

/** The full universal ladder: detection result → SSR or browser, with
 *  quality-gated escalation between rungs. */
async function scrapeFullLadder(
  url: string,
  site: string,
  d: DetectionResult,
  onStatus: StatusSink,
  initialBlockReason: string | null,
  signal?: AbortSignal,
): Promise<ScrapeOutcome> {
  let blockReason = initialBlockReason;
  const onBlock = (reason: string) => {
    blockReason ??= reason;
  };
  let profile: BrowserProfileName | null = null;
  let learnedSelector: string | null = null;
  let apiEndpoint: string | null = null;
  let extractionStrategy: ExtractionStrategyName | 'network' | null = null;
  const csrOptions = {
    onProfile: (p: BrowserProfileName) => { profile = p; },
    onBlock,
    onApiEndpoint: (ep: string) => { apiEndpoint = ep; },
    onLearnedSelector: (sel: string) => { learnedSelector = sel; },
    signal,
  };

  let products: ScrapedProduct[];
  let method: ScrapeMethod;
  let quality: ExtractionQuality;

  if (d.renderType === 'SSR') {
    method = 'fast-html';
    onStatus({
      url, site, phase: 'scraping', renderType: 'SSR', method,
      message: `🚀 Scraping ${site} via Fast-HTML…`,
    });
    products = await scrapeSsrSite(d.html, url, site, (message) =>
      onStatus({ url, site, phase: 'scraping', renderType: 'SSR', method, message }),
      undefined, signal,
    );
    quality = scoreExtraction(products, url, d.html);

    // Escalate on QUALITY, not just count: 8 pieces of sidebar garbage
    // used to stop the ladder, satisfied. Keep whichever attempt scores
    // highest — the browser is not always right either.
    if (quality.score < config.quality.escalateBelow) {
      blockReason ??= detectBlock(d.html);
      method = 'browser';
      onStatus({
        url, site, phase: 'scraping', renderType: 'CSR', method,
        message: products.length === 0
          ? `🔁 No deals in static HTML — retrying ${site} via Browser…`
          : `🔁 Low-confidence result (score ${quality.score.toFixed(2)}${quality.flags.length ? `, ${quality.flags.join(', ')}` : ''}) — retrying ${site} via Browser…`,
      });
      const browserProducts = await scrapeCsrSite(
        url, site,
        (message) => onStatus({ url, site, phase: 'scraping', renderType: 'CSR', method, message }),
        csrOptions,
      );
      const browserQuality = scoreExtraction(browserProducts, url);
      if (browserQuality.score > quality.score) {
        products = browserProducts;
        quality = browserQuality;
        extractionStrategy = apiEndpoint ? 'network' : null;
        return {
          products, method, renderType: 'CSR', quality,
          profile, extractionStrategy, learnedSelector, apiEndpoint, blockReason,
        };
      }
      method = 'fast-html'; // the cheap rung was the better attempt after all
    }
    return {
      products, method, renderType: 'SSR', quality,
      profile: null, extractionStrategy, learnedSelector, apiEndpoint, blockReason,
    };
  }

  method = 'browser';
  onStatus({
    url, site, phase: 'scraping', renderType: 'CSR', method,
    message: `⏳ Scrolling ${site} via Browser Automation…`,
  });
  products = await scrapeCsrSite(
    url, site,
    (message) => onStatus({ url, site, phase: 'scraping', renderType: 'CSR', method, message }),
    csrOptions,
  );
  quality = scoreExtraction(products, url);
  if (profile === 'clean') method = 'browser-clean';
  extractionStrategy = apiEndpoint ? 'network' : null;
  return {
    products, method, renderType: 'CSR', quality,
    profile, extractionStrategy, learnedSelector, apiEndpoint, blockReason,
  };
}

/** Bookkeeping shared by every successful path: report + done event. */
function finalize(
  url: string,
  site: string,
  t0: number,
  d: DetectionResult,
  outcome: ScrapeOutcome,
  blockReason: string | null,
  onStatus: StatusSink,
  report: SiteReport[],
): ScrapedProduct[] {
  const durationMs = Date.now() - t0;
  const { products, quality } = outcome;

  // Zero products + block signals = "we got walled", NOT "no deals".
  if (products.length === 0 && blockReason) {
    report.push({
      url, site, renderType: d.renderType, status: 'blocked',
      productCount: 0, durationMs, blockReason,
    });
    onStatus({
      url, site, phase: 'done', renderType: d.renderType, count: 0, durationMs,
      blockReason,
      message: `🛡️ Blocked by anti-bot: ${blockReason}`,
    });
    return products;
  }

  report.push({
    url, site, renderType: d.renderType, status: 'ok',
    productCount: products.length, durationMs, method: outcome.method, quality,
  });
  onStatus({
    url, site, phase: 'done', renderType: d.renderType, count: products.length, durationMs,
    qualityScore: quality.score, qualityFlags: quality.flags,
    message: products.length
      ? `✅ ${products.length} deals found in ${(durationMs / 1000).toFixed(1)}s (confidence ${(quality.score * 100).toFixed(0)}%)`
      : `⚠️ No deal cards matched on ${site}`,
  });
  return products;
}
