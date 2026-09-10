import { gunzipSync } from 'node:zlib';
import axios from 'axios';
import { config } from '../config';
import type {
  CandidateSource,
  DealCandidate,
  DiscoveryReport,
  ScrapedProduct,
} from '../types';
import { fetchHtml } from '../services/detector';
import { assertPublicUrl } from '../utils/ssrf';
import { allowedByRobots, sitemapsFromRobots } from '../utils/robots';
import { normalizeUrl } from '../utils/sites';
import { isSameSite, registrableDomain } from '../utils/sameSite';
import { hostRateLimiter } from '../utils/rateLimit';
import { canonicalizeUrl } from './canonicalize';
import { harvestLinks, USABLE_ANCHOR_FLOOR } from './harvest';
import { parseSitemap } from './sitemap';
import { fingerprintPlatform, probePathsFor, type Platform } from './platform';
import { scoreCandidate, type RawCandidate } from './score';
import { dedupeCandidates } from './fingerprint';
import { finalScore, verifyCandidate } from './verify';
import { matchesAnyPattern, seedableInclude } from './userPatterns';
import * as registry from './registry';
import { lookupMemo, writeMemo } from './memo';

/**
 * D5 — the discovery orchestrator: a bounded best-first search over ONE
 * registrable domain with a hard fetch budget. Never a crawl.
 *
 *   sources (cheapest first, tiered with early exit)
 *     → canonicalize → same-site guard → score → rank
 *     → verify top candidates (≤ maxVerify cheap fetches)
 *     → fingerprint dedupe → top-K out
 *
 * Every fetch passes: canonicalize → isSameSite → assertPublicUrl →
 * robots → rate limiter. No shortcuts, including sitemap URLs (remote
 * content too). Budget exhaustion is a normal, REPORTED outcome
 * (budgetExhausted: true), never an error.
 */

/** Injectable for network-free tests — production wiring uses fetchHtml. */
export type FetchLike = (url: string, signal?: AbortSignal) => Promise<string>;

/** .xml.gz sitemaps need a binary fetch + gunzip; fetchHtml is text-only.
 *  Same guard chain as everything else: SSRF → rate limiter → fetch. */
async function fetchSitemapDoc(url: string, signal?: AbortSignal): Promise<string> {
  if (!/\.gz(?:$|\?)/i.test(url)) return fetchHtml(url, signal);
  await assertPublicUrl(url);
  await hostRateLimiter.waitTurn(new URL(url).hostname);
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    signal,
    timeout: config.detect.timeoutMs,
    maxContentLength: 20 * 1024 * 1024,
  });
  return gunzipSync(Buffer.from(res.data)).toString('utf8');
}

export interface DiscoveryHooks {
  /** Progress lines for SSE (D7 wires these to site-status events). */
  onProgress?: (message: string) => void;
  /** Browser render for the Tier-4 CSR fallback. Absent ⇒ Tier 4 skipped.
   *  null ⇒ the render failed — degrade to the cheap tiers' yield. */
  renderPage?: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<{ html: string; seenApiUrls: string[] } | null>;
  fetchFn?: FetchLike;
  /** Registry facade (D6.5) — injectable so tests stay in-memory. The
   *  default wiring hits the real registry + memo. */
  registry?: {
    recordsFor(domain: string): registry.DealPageRecord[];
    upsert(input: registry.UpsertInput): void;
    recordCheck(id: string, outcome: registry.CheckOutcome): void;
    isExcluded(canonicalUrl: string): boolean;
  };
  /** Short-TTL memo of how to search this site (D6.4) — injectable. */
  memo?: () => import('./memo').DiscoveryMemo | null;
  /** robots.txt Sitemap: lookup — injectable so CI stays network-free. */
  robotsSitemaps?: (origin: string) => Promise<string[]>;
  /** Per-run limit overrides (tests; production defaults come from config). */
  limits?: Partial<
    Pick<
      typeof config.discovery,
      'maxVerify' | 'maxScrape' | 'minCandidates' | 'maxFetches' | 'maxDurationMs'
    >
  >;
  /** D7.1 user pins — skip scoring, still verified. Exact paths/URLs seed
   *  the frontier even when no tier surfaces them; `*` globs only match
   *  what the tiers discover. */
  include?: string[];
  /** D7.1 user exclusions — matched candidates are rejected before scoring
   *  and never fetched (visible in the report's rejected list). */
  exclude?: string[];
}

/** The include/exclude pair threaded through intake. */
interface UserPatterns {
  include?: string[] | undefined;
  exclude?: string[] | undefined;
}

export interface DiscoveryOutcome {
  report: DiscoveryReport;
  /** Top-K verified candidates, ranked — these go to scrapeUrls(). */
  selected: DealCandidate[];
  /** Every verified candidate INCLUDING the top-K losers (all upserted to
   *  the registry, D6.5 step 4 — tomorrow's scheduler run starts from them). */
  verified: DealCandidate[];
  /** Verification-fetched HTML per selected URL — the winner is never
   *  fetched twice. */
  preFetchedHtml: Map<string, string>;
  /** Products seen during verification, per selected URL (fingerprint reuse). */
  preVerifiedProducts: Map<string, ScrapedProduct[]>;
  /** Detected platform fingerprint (memo, D6.4). */
  platform: string | null;
}

/** A single budget object threaded through every source and checked before
 *  EVERY fetch. Time + count both bound the search. */
export class DiscoveryBudget {
  fetches = 0;
  private readonly startedAt = Date.now();
  exhausted = false;

  constructor(
    private readonly maxFetches = config.discovery.maxFetches,
    private readonly maxDurationMs = config.discovery.maxDurationMs,
  ) {}

  /** True when one more fetch fits inside both caps. */
  canFetch(): boolean {
    return (
      !this.exhausted &&
      this.fetches < this.maxFetches &&
      Date.now() - this.startedAt < this.maxDurationMs
    );
  }

  /** Record a fetch. Marks exhaustion when either cap is now hit. */
  spend(): void {
    this.fetches++;
    if (this.fetches >= this.maxFetches || Date.now() - this.startedAt >= this.maxDurationMs) {
      this.exhausted = true;
    }
  }

  get durationMs(): number {
    return Date.now() - this.startedAt;
  }
}

const enough = (cands: DealCandidate[], min: number): boolean =>
  cands.filter((c) => c.priorScore >= 0.55).length >= min;

interface IntakeResult {
  candidate: DealCandidate;
  /** Set ⇒ hard reject: recorded in the report, never fetched. */
  rejectReason: string | null;
}

/** Candidate intake pipeline: canonicalize → same-site → excluded → score.
 *  Returns null only for URLs that may not even be REPORTED (off-site,
 *  excluded, uncanonicalizable); scoring rejects are returned with their
 *  reason so the report can show them. */
function intake(
  raw: RawCandidate & { url: string },
  rootUrl: string,
  isExcluded: ((url: string) => boolean) | undefined,
  patterns?: UserPatterns,
): IntakeResult | null {
  const canonical = canonicalizeUrl(raw.url, rootUrl);
  if (!canonical) return null;
  if (!config.discovery.allowCrossSite && !isSameSite(canonical, rootUrl)) return null;
  if (isExcluded?.(canonical)) return null; // a remembered "no" costs no fetch

  // D7.1: this run's exclusions are VISIBLE rejects (unlike registry
  // exclusions, which are remembered facts and silently skipped).
  const excludedBy = matchesAnyPattern(patterns?.exclude, canonical);
  if (excludedBy) {
    return {
      candidate: {
        url: canonical,
        source: raw.source,
        evidence: [],
        priorScore: 0,
        label: raw.anchorText ?? raw.titleText ?? null,
      },
      rejectReason: `user-excluded:${excludedBy}`,
    };
  }

  // D7.1: a user pin skips SCORING — never the guard chain (canonicalize +
  // same-site above; SSRF + robots at fetch time). Still verified.
  const includedBy = matchesAnyPattern(patterns?.include, canonical);
  if (includedBy) {
    return {
      candidate: {
        url: canonical,
        source: 'user',
        evidence: [`user-pin:${includedBy}`],
        priorScore: 1,
        label: raw.anchorText ?? raw.titleText ?? null,
      },
      rejectReason: null,
    };
  }

  const scored = scoreCandidate({ ...raw, url: canonical });
  return {
    candidate: {
      url: canonical,
      source: raw.source,
      evidence: scored.evidence,
      priorScore: scored.score,
      label: raw.anchorText ?? raw.titleText ?? null,
    },
    rejectReason: scored.rejectReason,
  };
}

/* ── Tier 2: sitemaps (≤4 documents, hard-capped) ─────────────────── */

const MAX_SITEMAP_DOCS = 4;
const MAX_SITEMAP_BYTES = 5 * 1024 * 1024;
const MAX_SITEMAP_MATCHES = 200;

function sitemapChildAllowed(childUrl: string): boolean {
  // Follow an index only into children whose OWN URL scores on the lexicon
  // (sitemap-pages, sitemap-campaigns) or is unlabelled — NEVER into
  // sitemap-products-*.xml (a 50 MB product dump is not discovery).
  const path = new URL(childUrl).pathname.toLowerCase();
  if (/product|item|sku|catalog/i.test(path)) return false;
  return true;
}

async function harvestSitemaps(
  sitemapUrls: string[],
  rootUrl: string,
  budget: DiscoveryBudget,
  fetchFn: FetchLike,
  isExcluded: ((url: string) => boolean) | undefined,
  patterns?: UserPatterns,
  signal?: AbortSignal,
): Promise<IntakeResult[]> {
  const out: IntakeResult[] = [];
  const queue = [...sitemapUrls];
  let docs = 0;

  while (queue.length && docs < MAX_SITEMAP_DOCS && budget.canFetch()) {
    const docUrl = queue.shift()!;
    docs++;
    budget.spend();
    let xml: string;
    try {
      // .gz needs the binary path; everything else uses the injected fetch.
      xml = /\.gz(?:$|\?)/i.test(docUrl) ? await fetchSitemapDoc(docUrl, signal) : await fetchFn(docUrl, signal);
    } catch {
      continue; // a dead sitemap costs one fetch, never the run
    }
    if (xml.length > MAX_SITEMAP_BYTES) xml = xml.slice(0, MAX_SITEMAP_BYTES);
    const doc = parseSitemap(xml);

    if (doc.kind === 'index') {
      for (const child of doc.children) {
        if (queue.length + docs >= MAX_SITEMAP_DOCS) break;
        if (sitemapChildAllowed(child)) queue.push(child);
      }
      continue;
    }

    for (const entry of doc.urls) {
      if (out.length >= MAX_SITEMAP_MATCHES) break;
      const scored = intake(
        { url: entry.loc, source: 'sitemap' as CandidateSource, lastmodMs: entry.lastmodMs },
        rootUrl,
        isExcluded,
        patterns,
      );
      // Sitemap recall is broad; only keyword-positive URLs earn a slot.
      if (scored && !scored.rejectReason && scored.candidate.priorScore > 0.4) out.push(scored);
    }
  }
  return out;
}

/* ── Tier 3: platform probe pack (≤8 fetches) ─────────────────────── */

const MAX_PROBES = 8;

async function probePack(
  paths: string[],
  rootUrl: string,
  alreadyKnown: Set<string>,
  homepageHtml: string | null,
  budget: DiscoveryBudget,
  fetchFn: FetchLike,
  isExcluded: ((url: string) => boolean) | undefined,
  patterns?: UserPatterns,
  signal?: AbortSignal,
): Promise<{ candidates: IntakeResult[]; negativePaths: string[] }> {
  const candidates: IntakeResult[] = [];
  const negativePaths: string[] = [];
  const homeTitle = homepageHtml ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(homepageHtml)?.[1] : null;

  let probed = 0;
  for (const path of paths) {
    if (probed >= MAX_PROBES || !budget.canFetch()) break;
    const c = intake(
      { url: new URL(path, rootUrl).href, source: 'probe' },
      rootUrl,
      isExcluded,
      patterns,
    );
    if (!c || c.rejectReason || alreadyKnown.has(c.candidate.url)) continue; // probes are a
    // fallback, not a default — skip paths Tiers 0–2 already found

    probed++;
    budget.spend();
    let html: string;
    try {
      // GET, not HEAD — many storefronts 405 or lie on HEAD. fetchHtml's
      // maxContentLength keeps it cheap.
      html = await fetchFn(c.candidate.url, signal);
    } catch {
      negativePaths.push(path); // 404/410/unreachable → never probe again
      continue;
    }

    // Soft-404: HTML ~identical to the homepage (same title) is a reject,
    // not a hit — many platforms serve the homepage for unknown paths.
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
    if (homeTitle && title && title.trim() === homeTitle.trim()) {
      negativePaths.push(path);
      continue;
    }
    candidates.push(c);
  }
  return { candidates, negativePaths };
}

/* ── The frontier (D5.2) ──────────────────────────────────────────── */

interface FrontierEntry {
  candidate: DealCandidate;
  depth: number;
}

/** A verified HUB: many outbound links scoring ≥ 0.6, few products of its
 *  own — /offers is frequently a DIRECTORY of campaigns, not a listing. */
const HUB_MIN_LINKS = 3;
const HUB_LINK_SCORE = 0.6;
const HUB_MAX_PRODUCTS = 8;
const EXPAND_PRIORITY_DECAY = 0.7;

export async function discoverDealPages(
  domainInput: string,
  hooks: DiscoveryHooks = {},
  signal?: AbortSignal,
): Promise<DiscoveryOutcome> {
  const startedAt = Date.now();
  const fetchFn = hooks.fetchFn ?? fetchHtml;
  const onProgress = hooks.onProgress ?? (() => {});
  const limits = hooks.limits ?? {};
  const maxVerify = limits.maxVerify ?? config.discovery.maxVerify;
  const maxScrape = limits.maxScrape ?? config.discovery.maxScrape;
  const minCandidates = limits.minCandidates ?? config.discovery.minCandidates;
  const budget = new DiscoveryBudget(limits.maxFetches, limits.maxDurationMs);

  const rootUrl = normalizeUrl(domainInput);
  if (!rootUrl) throw new Error(`Invalid domain: ${domainInput}`);
  const domain = registrableDomain(new URL(rootUrl).hostname) ?? new URL(rootUrl).hostname;
  let platform: Platform | null = null;

  /* ── D6.5: registry + memo facade. Defaults hit the real stores; tests
   *  inject in-memory fakes. ── */
  const reg = hooks.registry ?? {
    recordsFor: (d: string) => {
      registry.applyStaleness();
      return registry.list({ domain: d, status: ['active', 'pinned', 'stale'] });
    },
    upsert: (input: registry.UpsertInput) => void registry.upsert(input),
    recordCheck: (id: string, outcome: registry.CheckOutcome) => void registry.recordCheck(id, outcome),
    isExcluded: (url: string) => registry.isExcluded(url),
  };
  const isExcluded = reg.isExcluded;
  const patterns: UserPatterns = { include: hooks.include, exclude: hooks.exclude };
  const memo = hooks.memo ? hooks.memo() : lookupMemo(domain);
  if (memo) {
    platform = memo.platform as Platform | null;
    onProgress(`💾 Warm memo for ${domain} (platform: ${platform ?? 'unknown'})`);
  }

  const all = new Map<string, DealCandidate>(); // canonical URL → candidate
  const rejected: DealCandidate[] = [];
  let homepageHtml: string | null = null;
  const negativePaths: string[] = [...(memo?.negativePaths ?? [])];
  let fromMemo = false;

  /** Rejected candidates with an audit trail — the debugging surface. */
  const reject = (c: DealCandidate, reason: string) => {
    rejected.push({ ...c, evidence: [...c.evidence, `reject:${reason}`] });
  };

  const addCandidates = (list: Array<IntakeResult | null>) => {
    for (const item of list) {
      if (!item) continue;
      // Hard rejects (STOP segment, NEG token, zero keyword signal) never
      // enter the frontier — they never earn a fetch.
      if (item.rejectReason || item.candidate.priorScore <= 0) {
        reject(item.candidate, item.rejectReason ?? 'no-signal');
        continue;
      }
      if (all.size >= config.discovery.maxCandidates) return;
      const existing = all.get(item.candidate.url);
      // Keep the best evidence across duplicate discoveries.
      if (!existing || item.candidate.priorScore > existing.priorScore) {
        all.set(item.candidate.url, item.candidate);
      }
    }
  };

  /* D7.1: user pins — exact paths/URLs seed the frontier even when no tier
   *  surfaces them; `*` globs only MATCH what the tiers find. Pins are
   *  instructions, not hints: an uncovered pin blocks the warm-start
   *  shortcut below so it always earns its verification. */
  const pinSeeds = (hooks.include ?? [])
    .map(seedableInclude)
    .filter((s): s is string => s !== null)
    .map((s) => {
      try {
        return canonicalizeUrl(new URL(s, rootUrl).href, rootUrl);
      } catch {
        return null;
      }
    })
    .filter((s): s is string => s !== null);

  /* ── D6.5 WARM START — the saved list first. Cheap-verify this domain's
   *  active/pinned/due-stale records; survivors go straight to selection.
   *  Fewer than half surviving (or an empty list) ⇒ full discovery below,
   *  with the records seeding the frontier at priorScore 0.7. ── */
  const savedRecords = reg
    .recordsFor(domain)
    .filter((r) => {
      if (r.status === 'pinned' || r.status === 'active') return true;
      return r.status === 'stale' && r.nextCheckAt <= Date.now(); // due stale only
    })
    .filter((r) => !matchesAnyPattern(hooks.exclude, r.url)); // this run's "no" applies too
  const warmSurvivors: Array<{ candidate: DealCandidate; products: ScrapedProduct[] }> = [];
  const preFetchedHtml = new Map<string, string>();
  const preVerifiedProducts = new Map<string, ScrapedProduct[]>();

  if (savedRecords.length > 0) {
    fromMemo = true;
    onProgress(`💾 ${savedRecords.length} saved page(s) for ${domain} — re-verifying…`);
    let savedChecked = 0;
    for (const rec of savedRecords) {
      if (savedChecked >= maxVerify || !budget.canFetch()) break;
      savedChecked++;
      budget.spend();
      const candidate: DealCandidate = {
        url: rec.url,
        source: rec.source,
        evidence: rec.evidence,
        priorScore: 0.7, // D6.5: registry seeds the frontier at 0.7
        label: rec.label,
      };
      const outcome = await verifyCandidate(candidate, signal, undefined, fetchFn);
      candidate.verified = outcome.verification;
      candidate.finalScore = finalScore(candidate, outcome.verification);
      reg.recordCheck(rec.id, {
        kind: outcome.verification.rejectedReason?.startsWith('blocked')
          ? 'blocked'
          : outcome.verification.rejectedReason
            ? 'miss'
            : 'ok',
        ...(outcome.verification.rejectedReason
          ? {}
          : {
              verification: outcome.verification,
              fingerprintChanged:
                outcome.verification.productFingerprint !== rec.productFingerprint,
            }),
      } as registry.CheckOutcome);
      if (!outcome.verification.rejectedReason) {
        warmSurvivors.push({ candidate, products: outcome.products });
        if (outcome.html) preFetchedHtml.set(candidate.url, outcome.html);
        if (outcome.products.length) preVerifiedProducts.set(candidate.url, outcome.products);
        onProgress(
          `✅ saved ${new URL(rec.url).pathname || '/'}: ${outcome.verification.productCount} products`,
        );
      } else {
        onProgress(`❌ saved ${new URL(rec.url).pathname || '/'}: ${outcome.verification.rejectedReason}`);
        rejected.push(candidate);
      }
    }

    const majorityAlive = warmSurvivors.length * 2 >= savedChecked && savedChecked > 0;
    // A pin the saved list doesn't cover forces full discovery — the user
    // explicitly asked for that URL to be verified THIS run.
    const pinsCovered = pinSeeds.every((u) => savedRecords.some((r) => r.url === u));
    if (warmSurvivors.length > 0 && majorityAlive && pinsCovered) {
      // The saved list is healthy — skip full discovery entirely.
      const { kept, dupes } = dedupeCandidates(warmSurvivors);
      for (const d of dupes) {
        onProgress(`🗑️ ${new URL(d.url).pathname} duplicates ${new URL(d.duplicateOf).pathname}`);
      }
      const selected = [...kept]
        .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))
        .slice(0, maxScrape);
      onProgress(`🎯 Warm start: scraping ${selected.length} saved page(s), discovery skipped`);
      return {
        report: {
          domain,
          platform,
          candidatesFound: savedRecords.length,
          candidatesVerified: savedChecked,
          selected,
          rejected,
          fetchCount: budget.fetches,
          durationMs: Date.now() - startedAt,
          fromMemo: true,
          budgetExhausted: budget.exhausted,
        },
        selected,
        verified: kept,
        preFetchedHtml,
        preVerifiedProducts,
        platform,
      };
    }
    // Majority dead → fall through to FULL discovery, with the survivors
    // and ALL saved records seeding the frontier at priorScore 0.7.
    onProgress('🔁 Saved list mostly dead — running full discovery');
    for (const s of warmSurvivors) all.set(s.candidate.url, s.candidate);
    for (const rec of savedRecords) {
      if (all.has(rec.url) || isExcluded(rec.url)) continue;
      all.set(rec.url, {
        url: rec.url,
        source: 'memo',
        evidence: [...rec.evidence, 'seed:registry'],
        priorScore: 0.7,
        label: rec.label,
      });
    }
  }

  /* ── D7.1 pin seeding — before every tier, so no early exit can skip
   *  what the user explicitly asked for. Pins already in the frontier
   *  (warm survivors) keep their verified state. ── */
  addCandidates(
    pinSeeds
      .filter((u) => !all.has(u))
      .map((u) => intake({ url: u, source: 'user' as CandidateSource }, rootUrl, isExcluded, patterns)),
  );

  /* ── Tier 0: root + robots.txt sitemaps (robots fetch is cached per
   *  origin by utils/robots — effectively free) ── */
  const rootCandidate = intake({ url: rootUrl, source: 'root' }, rootUrl, isExcluded, patterns);
  if (rootCandidate) addCandidates([rootCandidate]);

  const origin = new URL(rootUrl).origin;
  const robotsSitemaps = hooks.robotsSitemaps
    ? await hooks.robotsSitemaps(origin).catch(() => [] as string[])
    : await sitemapsFromRobots(origin).catch(() => [] as string[]);

  /* ── Tier 1: homepage, fetched ONCE and reused four ways (platform
   *  fingerprint, link harvest, root verification, CSR detection) ── */
  if (budget.canFetch()) {
    budget.spend();
    try {
      await assertPublicUrl(rootUrl);
      if (
        !config.net.respectRobots ||
        config.net.robotsOverride ||
        (await allowedByRobots(rootUrl))
      ) {
        homepageHtml = await fetchFn(rootUrl, signal);
      }
    } catch {
      homepageHtml = null; // a dead root just means Tier 1 contributes nothing
    }
  }

  if (homepageHtml) {
    platform = fingerprintPlatform(homepageHtml);
    const harvested = harvestLinks(homepageHtml, rootUrl);
    onProgress(`🔗 Harvested ${harvested.length} links from the homepage`);
    addCandidates(
      harvested
        .map((h) =>
          intake(
            {
              url: h.url,
              source: h.source,
              anchorText: h.anchorText,
              titleText: h.titleText,
              inNavAndFooter: h.inNavAndFooter,
            },
            rootUrl,
            isExcluded,
            patterns,
          ),
        ),
    );
  }

  /* ── Tier 2: sitemaps — robots Sitemap: lines, then conventional paths ── */
  const sitemapSeeds = [
    ...robotsSitemaps,
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
  ].filter((u, i, a) => a.indexOf(u) === i);
  if (!enough([...all.values()], minCandidates) && sitemapSeeds.length && budget.canFetch()) {
    const fromSitemaps = await harvestSitemaps(
      sitemapSeeds,
      rootUrl,
      budget,
      fetchFn,
      isExcluded,
      patterns,
      signal,
    );
    if (fromSitemaps.length) onProgress(`🗺️ ${fromSitemaps.length} candidates from sitemaps`);
    addCandidates(fromSitemaps);
  }

  /* ── Tier 3: platform probe pack — only when cheap tiers didn't reach
   *  enough(). Probing 8 conventional paths is pointless if the nav already
   *  handed us verified deal pages. ── */
  if (!enough([...all.values()], minCandidates) && budget.canFetch()) {
    const probed = await probePack(
      probePathsFor(platform),
      rootUrl,
      new Set(all.keys()),
      homepageHtml,
      budget,
      fetchFn,
      isExcluded,
      patterns,
      signal,
    );
    negativePaths.push(...probed.negativePaths);
    if (probed.candidates.length) {
      onProgress(`🎯 ${probed.candidates.length} candidates from platform probes`);
    }
    addCandidates(probed.candidates);
  }

  /* ── Tier 4: browser-assisted harvest — LAST RESORT, only when the
   *  homepage was an SPA shell (< 15 usable anchors). ── */
  const anchorCount = homepageHtml ? harvestLinks(homepageHtml, rootUrl).length : 0;
  if (
    !enough([...all.values()], minCandidates) &&
    budget.canFetch() &&
    hooks.renderPage &&
    anchorCount < USABLE_ANCHOR_FLOOR
  ) {
    budget.spend(); // one render, not a fetch — still budgeted
    try {
      const rendered = await hooks.renderPage(rootUrl, signal);
      if (rendered) {
        const harvested = harvestLinks(rendered.html, rootUrl);
        addCandidates(
          harvested
            .map((h) =>
              intake(
                { url: h.url, source: h.source, anchorText: h.anchorText, titleText: h.titleText },
                rootUrl,
                isExcluded,
                patterns,
              ),
            ),
        );
        // Campaign API endpoints seen on the wire — strictly better than any
        // keyword guess.
        addCandidates(
          rendered.seenApiUrls.map((u) =>
            intake({ url: u, source: 'network' as CandidateSource }, rootUrl, isExcluded, patterns),
          ),
        );
        onProgress(`🖥️ Browser render added candidates (SPA shell fallback)`);
      }
    } catch {
      // render failure degrades to whatever the cheap tiers found
    }
  }

  /* ── Frontier: pop by priorScore, verify ≤ maxVerify, expand hubs one
   *  level (decayed). Every verification is ONE cheap fetch. ── */
  const frontier: FrontierEntry[] = [...all.values()]
    .map((candidate) => ({ candidate, depth: 0 }))
    .sort((a, b) => b.candidate.priorScore - a.candidate.priorScore);

  const verifiedOk: Array<{ candidate: DealCandidate; products: ScrapedProduct[] }> = [
    ...warmSurvivors, // warm survivors are already verified — keep them
  ];
  let verifiedCount = 0;

  while (frontier.length && verifiedCount < maxVerify && budget.canFetch()) {
    frontier.sort((a, b) => b.candidate.priorScore - a.candidate.priorScore);
    const { candidate, depth } = frontier.shift()!;
    if (candidate.verified) continue;

    const isRoot = candidate.url === rootCandidate?.candidate.url;
    if (!isRoot) {
      // The guard chain, in order, before ANY fetch of a discovered URL.
      if (!config.discovery.allowCrossSite && !isSameSite(candidate.url, rootUrl)) continue;
      try {
        await assertPublicUrl(candidate.url);
      } catch {
        continue;
      }
      if (config.net.respectRobots && !config.net.robotsOverride) {
        if (!(await allowedByRobots(candidate.url))) {
          candidate.verified = undefined;
          rejected.push({ ...candidate, evidence: [...candidate.evidence, 'reject:robots.txt'] });
          continue;
        }
      }
      budget.spend();
    }

    onProgress(`🧪 Verifying ${new URL(candidate.url).pathname || '/'} …`);
    const outcome = await verifyCandidate(
      candidate,
      signal,
      isRoot && homepageHtml ? homepageHtml : undefined,
      fetchFn,
    );
    verifiedCount++;
    candidate.verified = outcome.verification;
    candidate.finalScore = finalScore(candidate, outcome.verification);

    // D4.2: 'demoted' is NOT a reject — kept, ranked below accepted
    // candidates. Everything else with a reason is a hard reject.
    if (outcome.verification.rejectedReason === 'demoted') {
      candidate.finalScore = Math.min(candidate.finalScore ?? 1, 0.49); // below any accepted
      verifiedOk.push({ candidate, products: outcome.products });
      if (outcome.html) preFetchedHtml.set(candidate.url, outcome.html);
      if (outcome.products.length) preVerifiedProducts.set(candidate.url, outcome.products);
      continue;
    }
    if (outcome.verification.rejectedReason) {
      rejected.push(candidate);
      continue;
    }

    verifiedOk.push({ candidate, products: outcome.products });
    if (outcome.html) preFetchedHtml.set(candidate.url, outcome.html);
    if (outcome.products.length) preVerifiedProducts.set(candidate.url, outcome.products);
    onProgress(
      `✅ ${new URL(candidate.url).pathname || '/'}: ${outcome.verification.productCount} products, ` +
        `${Math.round(outcome.verification.dealDensity * 100)}% discounted`,
    );

    // Hub expansion: a verified hub's outbound links join the frontier at
    // depth+1 with decayed priority. ONE level — two would be a crawl.
    if (
      outcome.html &&
      depth < config.discovery.maxExpandDepth &&
      outcome.verification.productCount <= HUB_MAX_PRODUCTS
    ) {
      const links = harvestLinks(outcome.html, candidate.url)
        .map((h) =>
          intake(
            { url: h.url, source: 'expanded' as CandidateSource, anchorText: h.anchorText },
            candidate.url,
            isExcluded,
            patterns,
          ),
        )
        .filter(
          (c): c is IntakeResult =>
            c !== null && !c.rejectReason && c.candidate.priorScore >= HUB_LINK_SCORE,
        )
        .filter((c) => !all.has(c.candidate.url))
        .slice(0, HUB_MIN_LINKS * 3);
      if (links.length >= HUB_MIN_LINKS) {
        for (const l of links) {
          l.candidate.priorScore *= EXPAND_PRIORITY_DECAY;
          l.candidate.evidence = [...l.candidate.evidence, `expanded-from:${candidate.url}`];
          all.set(l.candidate.url, l.candidate);
          frontier.push({ candidate: l.candidate, depth: depth + 1 });
        }
        onProgress(`🌐 ${new URL(candidate.url).pathname} is a hub — expanded ${links.length} links`);
      }
    }
  }

  /* ── Fingerprint dedupe BEFORE the expensive scrape: /deals and
   *  /collections/sale routinely serve the SAME product set. ── */
  const { kept, dupes } = dedupeCandidates(verifiedOk);
  for (const d of dupes) {
    onProgress(`🗑️ ${new URL(d.url).pathname} duplicates ${new URL(d.duplicateOf).pathname}`);
  }

  const ranked = [...kept].sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
  let selected = ranked.slice(0, maxScrape);
  if (selected.length) onProgress(`🎯 Scraping top ${selected.length} of ${all.size} candidates`);

  /* ── D9 GRACEFUL DEGRADATION — some storefronts have NO dedicated deal
   *  page: discounts are scattered across ordinary category listings.
   *  When nothing selected cleared the accept bar:
   *   1. if selected is entirely empty, verify up to fallback.maxVerify of
   *      the best UNVERIFIED nav/hero/body/footer anchors — they score ~0
   *      on the deal lexicon but they ARE product listings;
   *   2. keep any listing with dealDensity ≥ fallback.minDensity;
   *   3. mark every selected candidate 'fallback:category-listing' — the
   *      degradation is explicit, and the scraper post-filters their
   *      products to discounted-only (D9 step 2). ── */
  const accepted = selected.filter((c) => c.verified && !c.verified.rejectedReason);
  if (!accepted.length) {
    if (!selected.length) {
      const FB_SOURCE_ORDER: Partial<Record<CandidateSource, number>> = {
        nav: 0,
        hero: 1,
        body: 2,
        footer: 3,
      };
      const pool = [...all.values()]
        .filter((c) => !c.verified && FB_SOURCE_ORDER[c.source] !== undefined)
        .sort(
          (a, b) =>
            FB_SOURCE_ORDER[a.source]! - FB_SOURCE_ORDER[b.source]! ||
            b.priorScore - a.priorScore,
        );
      const fb = config.discovery.fallback;
      let tried = 0;
      for (const candidate of pool) {
        if (tried >= fb.maxVerify || !budget.canFetch()) break;
        // The guard chain, before ANY fetch — same rules as the frontier.
        try {
          await assertPublicUrl(candidate.url);
        } catch {
          continue;
        }
        if (config.net.respectRobots && !config.net.robotsOverride) {
          if (!(await allowedByRobots(candidate.url))) {
            rejected.push({ ...candidate, evidence: [...candidate.evidence, 'reject:robots.txt'] });
            continue;
          }
        }
        budget.spend();
        tried++;
        if (tried === 1) onProgress(`🍂 No dedicated deal page — checking top category listings…`);
        onProgress(`🧪 Verifying ${new URL(candidate.url).pathname || '/'} …`);
        const outcome = await verifyCandidate(candidate, signal, undefined, fetchFn);
        verifiedCount++;
        candidate.verified = outcome.verification;
        candidate.finalScore = finalScore(candidate, outcome.verification);
        // The fallback's own bar: a real listing that BEARS deals. Hard
        // rejects (not-a-listing / blocked / fetch-failed / CSR) and
        // deal-sparse pages are reported, not kept.
        if (
          outcome.verification.rejectedReason &&
          outcome.verification.rejectedReason !== 'demoted'
        ) {
          rejected.push(candidate);
          continue;
        }
        if (outcome.verification.dealDensity < fb.minDensity) {
          rejected.push({
            ...candidate,
            evidence: [...candidate.evidence, `reject:sparse-deals(<${fb.minDensity})`],
          });
          continue;
        }
        // Never let a fallback outrank a real deal page from a prior run.
        candidate.finalScore = Math.min(candidate.finalScore ?? 1, 0.49);
        candidate.source = 'body'; // the answer is the listing itself (D9.3)
        kept.push(candidate); // joins the registry upsert + return below
        selected.push(candidate);
        if (outcome.html) preFetchedHtml.set(candidate.url, outcome.html);
        if (outcome.products.length) preVerifiedProducts.set(candidate.url, outcome.products);
        onProgress(
          `🍂 ${new URL(candidate.url).pathname}: ${outcome.verification.productCount} products, ` +
            `${Math.round(outcome.verification.dealDensity * 100)}% discounted — category fallback`,
        );
      }
      selected = selected
        .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))
        .slice(0, maxScrape);
    }
    if (selected.length) {
      for (const c of selected) {
        if (!c.evidence.includes('fallback:category-listing')) {
          c.evidence = [...c.evidence, 'fallback:category-listing'];
        }
      }
      onProgress(
        `🎯 No dedicated sale page — filtered discounted items from ${selected.length} category page(s)`,
      );
    }
  }

  /* ── D6.5 step 4: EVERY verified candidate is upserted into the registry
   *  — including the ones that lost the top-K cut. They cost nothing to
   *  store and they are exactly what tomorrow's scheduler run should try.
   *  Health was already updated by recordCheck during verification; the
   *  upsert refreshes lastSeenAt + evidence without touching it. ── */
  for (const c of kept) {
    reg.upsert({
      url: c.url,
      source: c.source,
      evidence: c.evidence,
      label: c.label,
      finalScore: c.finalScore ?? c.priorScore,
      verified: c.verified,
    });
  }

  // D6.4: write the memo — how to search this site next time.
  if (!fromMemo) {
    writeMemo(domain, {
      platform,
      sitemapUrls: robotsSitemaps,
      negativePaths,
    });
  }

  const report: DiscoveryReport = {
    domain,
    platform,
    candidatesFound: all.size,
    candidatesVerified: verifiedCount,
    selected,
    rejected,
    fetchCount: budget.fetches,
    durationMs: Date.now() - startedAt,
    fromMemo,
    budgetExhausted: budget.exhausted,
  };

  return {
    report,
    selected,
    verified: kept,
    preFetchedHtml,
    preVerifiedProducts,
    platform,
  };
}
