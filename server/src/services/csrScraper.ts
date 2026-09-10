import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import type { Browser, Page } from 'playwright';
import { browserHeaders } from '../utils/userAgents';
import { extractProductsFromHtml, extractWithDiagnostics, walkForProducts } from './extractor';
import { ProductMerger } from '../utils/merge';
import {
  clickControl,
  findLoadMoreControl,
  findNextPageControl,
  snapshotPage,
  waitForContentChange,
} from './pagination';
import type { ScrapedProduct } from '../types';
import { assertPublicUrl, isAllowedBrowserRequest } from '../utils/ssrf';
import { AbortedError, throwIfAborted } from '../utils/abort';
import { detectBlock } from '../utils/block';
import { CARD_SELECTORS } from './extractor';
import { config } from '../config';

const NAV_TIMEOUT_MS = config.scrape.navTimeoutSecs * 1000;
/** Multi-page browsing multiplies page work — keep the handler generous. */
const HANDLER_TIMEOUT_MS = config.scrape.handlerTimeoutSecs * 1000;
const SCROLL_ROUNDS = config.scrape.scrollRounds;
const MAX_LOAD_MORE_CLICKS = config.scrape.maxLoadMoreClicks;
/** After this many clicks with zero new products, the button is exhausted. */
const MAX_STALE_CLICKS = config.scrape.maxStaleClicks;
const MAX_PAGES = config.scrape.maxPages;
const MAX_PRODUCTS_TOTAL = config.caps.total;

export type ProgressSink = (message: string) => void;

/* ── Universal browser-profile ladder ──────────────────────────────
 * No single browser fingerprint works everywhere: some storefronts hydrate
 * slowly (or not at all) under a customised header set, while others reject
 * stock configs. Instead of per-site special cases we walk a ladder of
 * progressively plainer profiles, escalating on ONE universal signal:
 * the previous profile extracted ZERO products.
 */
export type BrowserProfileName = 'hardened' | 'clean' | 'proxied';

interface BrowserProfile {
  name: BrowserProfileName;
  label: string; // human label for progress messages
  /** Draw UA + viewport + DPR + platform from Playwright's REAL device
   *  descriptors — a random UA paired with a random viewport is itself an
   *  anomaly; real devices are internally consistent. */
  devicePool: boolean;
  /** Patch navigator.webdriver / chrome.runtime / plugins / languages. */
  patchFingerprint: boolean;
  extraHeaders: boolean;
  blockHeavyAssets: boolean;
  proxyUrl: string | null;
}

/** Desktop device descriptors — consistent UA/viewport/DPR/touch tuples. */
const DESKTOP_DEVICE_POOL = [
  'Desktop Chrome',
  'Desktop Chrome HiDPI',
  'Desktop Edge',
  'Desktop Firefox',
  'Desktop Safari',
] as const;

const BASE_PROFILES: readonly BrowserProfile[] = [
  // 1) hardened — real device fingerprint + header set + font/media
  //    blocking: fastest, and enough for most storefronts.
  {
    name: 'hardened', label: 'stealth',
    devicePool: true, patchFingerprint: true, extraHeaders: true, blockHeavyAssets: true,
    proxyUrl: null,
  },
  // 2) clean — everything stock, the closest thing to a fresh browser
  //    install: some apps stall their hydration under foreign header sets.
  {
    name: 'clean', label: 'clean',
    devicePool: false, patchFingerprint: false, extraHeaders: false, blockHeavyAssets: false,
    proxyUrl: null,
  },
];

/** The proxied rung exists only when PROXY_URL is configured — a pure
 *  config addition, exactly the extension point the ladder was built for. */
const BROWSER_PROFILES: readonly BrowserProfile[] = config.net.proxy
  ? [
      {
        name: 'proxied', label: 'proxied',
        devicePool: true, patchFingerprint: true, extraHeaders: true, blockHeavyAssets: true,
        proxyUrl: config.net.proxy,
      },
      ...BASE_PROFILES,
    ]
  : BASE_PROFILES;

export interface CsrScrapeOptions {
  /** Fired when a crawl attempt starts on a profile (for reporting). */
  onProfile?: (profile: BrowserProfileName) => void;
  /** Fired when a rendered page looks like a bot wall (0 products + block
   *  signals). A block says nothing about strategy correctness — callers
   *  must NOT learn from it (Phase 4 cache rule). */
  onBlock?: (reason: string) => void;
  /** Fired when a network response yields products — the endpoint is the
   *  prize: usually ?page=N or a cursor that plain axios can hit next run,
   *  skipping the browser entirely (feeds the Phase 4 strategy cache). */
  onApiEndpoint?: (url: string) => void;
  /** Phase 4: start the profile ladder at a remembered rung instead of the
   *  top. Unknown names fall back to the full ladder. */
  startAtProfile?: BrowserProfileName;
  /** Phase 4: learned card selectors for this host — tried first in the
   *  DOM rung's bank. */
  extraCardSelectors?: string[];
  /** Phase 4: receives the DOM-rung selector that matched the most cards. */
  onLearnedSelector?: (selector: string) => void;
  /** Phase 6: client-disconnect cancellation — closing the SSE stream
   *  aborts the crawl so no Chromium work outlives its audience. */
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------ */
/* ONE shared browser. Every attempt gets a fresh CONTEXT — identical  */
/* isolation to a fresh browser, a fraction of the cost, and no        */
/* crawlee: we used a whole crawling framework to open a single page.  */
/* ------------------------------------------------------------------ */

let browserPromise: Promise<Browser> | null = null;

function sharedBrowser(): Promise<Browser> {
  browserPromise ??= chromium
    .launch({ headless: true })
    .then((b) => {
      // a crashed browser must not poison every future attempt
      b.on('disconnected', () => {
        browserPromise = null;
      });
      return b;
    })
    .catch((e) => {
      browserPromise = null;
      throw e;
    });
  return browserPromise;
}

const STORAGE_STATE_DIR = fileURLToPath(new URL('../../.cache/storage-state', import.meta.url));

/** Per-host cookie/storage persistence — consent dismissal carries across runs. */
function storageStatePath(host: string): string {
  return `${STORAGE_STATE_DIR}/${host.replace(/[^a-z0-9.-]/gi, '_')}.json`;
}

/** Selectors we wait for before scrolling — any hit means the app booted. */
const WAIT_SELECTORS = [
  '[class*="product" i]',
  '[data-product]',
  '[itemtype*="Product"]',
  'main',
  '#root > *',
  '#app > *',
];

const CARDS_SELECTOR = CARD_SELECTORS.join(',');

/**
 * Money-shaped text, currency-agnostic: symbol-first (৳$€£₹₨₦﷼…) or
 * code-first (Tk 1,299 / BDT 950 / Rs. 999 / RM 45 / AED 120 / USD 19.99…).
 */
const MONEY_TEXT_RE =
  '[৳$€£₹₨₦﷼]\\s*[\\d,]{2,}|(?:Tk|BDT|Rs|INR|RM|Rp|AED|SAR|USD|EUR|GBP|kr)\\.?\\s*[\\d,]{2,}';

/** Short button labels that dismiss consent/cookie/app-install overlays. */
const CONSENT_TEXT_RE =
  '^(accept( all)?( cookies)?|i agree|agree|got it|ok|okay|ok,? got it|no thanks|dismiss|allow( all)?)$';

async function waitForAnySelector(page: Page, selectors: string[], timeoutMs: number): Promise<string | null> {
  return Promise.any(
    selectors.map((s) =>
      page.waitForSelector(s, { timeout: timeoutMs, state: 'attached' }).then(() => s),
    ),
  ).catch(() => null);
}

/**
 * Adaptive wait (replaces fixed sleeps): resolve when the card count has
 * been stable for a few polling ticks. Faster on fast sites, more reliable
 * on slow ones — fixed sleeps are simultaneously too long and too short.
 */
async function waitForCardStability(page: Page, timeoutMs = 15_000): Promise<void> {
  await page
    .waitForFunction(
      (sel: string) => {
        const w = window as unknown as { __lastCount?: number; __stableTicks?: number };
        const n = document.querySelectorAll(sel).length;
        const stable = n === w.__lastCount ? (w.__stableTicks ?? 0) + 1 : 0;
        w.__lastCount = n;
        w.__stableTicks = stable;
        return stable >= 3;
      },
      CARDS_SELECTOR,
      { timeout: timeoutMs, polling: 400 },
    )
    .then(() => undefined)
    .catch(() => undefined);
}

/**
 * Universal "app finished rendering" signal for skeleton SPAs: resolves when
 * the DOM has been quiet for `quietMs` (hard-capped at `timeoutMs`).
 */
async function waitForDomSettle(page: Page, quietMs = 1500, timeoutMs = 8_000): Promise<void> {
  await page
    .evaluate(
      ({ quietMs: q, timeoutMs: t }) =>
        new Promise<void>((resolve) => {
          const body = document.body;
          if (!body) {
            resolve();
            return;
          }
          const finish = (observer?: MutationObserver) => {
            observer?.disconnect();
            resolve();
          };
          let quiet: ReturnType<typeof setTimeout> | undefined;
          const obs = new MutationObserver(() => {
            if (quiet) clearTimeout(quiet);
            quiet = setTimeout(() => finish(obs), q);
          });
          setTimeout(() => finish(obs), t); // hard cap
          quiet = setTimeout(() => finish(obs), q); // page may already be quiet
          obs.observe(body, { childList: true, subtree: true, characterData: true, attributes: true });
        }),
      { quietMs, timeoutMs },
    )
    .catch(() => undefined);
}

/**
 * Universal consent/overlay dismissal. Cookie bars, GDPR banners and
 * app-install sheets block scrolling and swallow clicks on many storefronts.
 * Best-effort: clicks the first visible, short-labelled accept-style button
 * (if any), then moves on. Runs before scrolling so lazy content and
 * hydration aren't gated behind a modal.
 */
async function dismissOverlays(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const handle = await page
      .evaluateHandle((reSrc: string) => {
        const re = new RegExp(reSrc, 'i');
        const candidates = document.querySelectorAll<HTMLElement>(
          'button, a, [role="button"], input[type="button"], input[type="submit"]',
        );
        for (const el of candidates) {
          const raw = el.textContent ?? (el as HTMLInputElement).value ?? '';
          const text = raw.replace(/\s+/g, ' ').trim();
          if (text.length === 0 || text.length > 24 || !re.test(text)) continue;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden') return el;
        }
        return null;
      }, CONSENT_TEXT_RE)
      .catch(() => null);
    if (!handle) break;
    const el = handle.asElement();
    if (!el) {
      await handle.dispose();
      break;
    }
    try {
      await el.click({ timeout: 1200 });
      await page.waitForTimeout(400);
    } catch {
      /* overlay vanished or resisted the click — either way, move on */
    }
    await handle.dispose();
  }
}

/** Scroll to the bottom in steps to trigger lazy-loaded deal cards. */
async function autoScroll(page: Page, rounds = SCROLL_ROUNDS): Promise<void> {
  let lastHeight = 0;
  let stableRounds = 0;
  for (let i = 0; i < rounds; i++) {
    const height: number = await page.evaluate(() => document.body?.scrollHeight ?? 0);
    if (height === lastHeight) {
      stableRounds += 1;
      if (stableRounds >= 2) break;
    } else {
      stableRounds = 0;
    }
    lastHeight = height;
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 1.4)));
    await page.waitForTimeout(650);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * Product accumulator shared across page states. Extraction runs per state
 * and results merge with the same title|price key the extractor uses —
 * append-mode (load more) overlaps and replace-mode (pagination) churn
 * both collapse to one entry per product. Images/links get backfilled.
 */
class ProductAccumulator {
  private readonly merger = new ProductMerger(MAX_PRODUCTS_TOTAL);

  constructor(
    private site: string,
    private onBlock?: (reason: string) => void,
    private options?: CsrScrapeOptions,
  ) {}

  /** Merge an externally-sourced batch (network interception) through the
   *  same dedupe/enrich path as DOM extractions. */
  addProducts(products: ScrapedProduct[], sourceUrl: string): number {
    return this.merger.add(products, sourceUrl);
  }

  /**
   * Extract from the top document; if it has nothing, fall back to child
   * frames — campaign storefronts are routinely embedded via iframes, a
   * universal pattern. The dedupe keys make any overlap harmless, and the
   * fallback only fires while we hold zero products (cost contained).
   */
  async collect(page: Page): Promise<number> {
    const html = await page.content();
    const pageUrl = page.url();
    const { products, diagnostics } = extractWithDiagnostics(
      html,
      pageUrl,
      this.site,
      this.options?.extraCardSelectors,
    );
    if (diagnostics.matchedCardSelector) {
      this.options?.onLearnedSelector?.(diagnostics.matchedCardSelector);
    }
    let added = this.merger.add(products, pageUrl);
    if (added === 0 && this.merger.size === 0) {
      // Zero products AND block signals in the rendered DOM = we got walled,
      // not "the site has no deals". Report it distinctly.
      const blockReason = detectBlock(html);
      if (blockReason) this.onBlock?.(blockReason);
      for (const frame of page.frames()) {
        if (frame === page.mainFrame() || frame.url().startsWith('about:')) continue;
        try {
          const frameHtml = await frame.content();
          const frameUrl = frame.url();
          added += this.merger.add(
            extractProductsFromHtml(frameHtml, frameUrl, this.site),
            frameUrl,
          );
        } catch {
          /* frame detached or cross-origin mid-read — skip it */
        }
      }
    }
    return added;
  }

  get size(): number {
    return this.merger.size;
  }

  values(): ScrapedProduct[] {
    return this.merger.values();
  }
}

/**
 * Phase A — "Load More" buttons (flash-sale pages & co.): keep clicking
 * while each click actually grows the listing. Stops when the control
 * disappears, gets disabled, or stops producing new products.
 * Returns how many productive clicks happened.
 */
async function drainLoadMore(page: Page, acc: ProductAccumulator, onProgress: ProgressSink): Promise<number> {
  let productiveClicks = 0;
  let staleClicks = 0;

  for (let click = 1; click <= MAX_LOAD_MORE_CLICKS; click++) {
    const control = await findLoadMoreControl(page);
    if (!control) break;

    const before = await snapshotPage(page);
    const beforeUrl = page.url();

    if (!(await clickControl(page, control))) break;

    const changed = await waitForContentChange(page, before, beforeUrl);
    await autoScroll(page, 4); // trigger lazy images on the freshly appended chunk
    await waitForCardStability(page, 9_000);

    const added = await acc.collect(page);

    if (page.url() !== beforeUrl) {
      // "Load more" turned out to be a disguised page link — the snapshot
      // above captured the new state; don't loop a navigation trail here.
      productiveClicks += 1;
      break;
    }
    if (!changed || added === 0) {
      staleClicks += 1;
      if (staleClicks >= MAX_STALE_CLICKS) break;
    } else {
      staleClicks = 0;
      productiveClicks += 1;
      onProgress(`🖱️ “Load More” ×${productiveClicks} — ${acc.size} deals so far…`);
    }
    if (acc.size >= MAX_PRODUCTS_TOTAL) break;
  }
  return productiveClicks;
}

/**
 * Phase B — classic pagination: only attempted when no load-more control
 * fired (sites use one or the other). Clicks "next", waits for the listing
 * to swap, re-scrolls, and snapshots each page state.
 */
async function drainPagination(page: Page, acc: ProductAccumulator, onProgress: ProgressSink): Promise<void> {
  const seenUrls = new Set<string>([page.url()]);

  for (let pg = 2; pg <= MAX_PAGES; pg++) {
    const next = await findNextPageControl(page);
    if (!next) break;

    const before = await snapshotPage(page);
    const beforeUrl = page.url();

    if (!(await clickControl(page, next))) break;

    const changed = await waitForContentChange(page, before, beforeUrl, 12_000);
    if (!changed) break;

    // navigated somewhere already scraped (or a canonicalized duplicate)
    if (page.url() !== beforeUrl) {
      if (seenUrls.has(page.url())) break;
      seenUrls.add(page.url());
    }

    await waitForAnySelector(page, WAIT_SELECTORS, 8_000);
    await autoScroll(page, 6);
    await waitForCardStability(page, 9_000);

    const added = await acc.collect(page);
    onProgress(`📄 Page ${pg} scraped — ${acc.size} deals so far…`);
    if (added === 0) break; // page rendered but nothing new → done
    if (acc.size >= MAX_PRODUCTS_TOTAL) break;
  }
}

interface CrawlOutcome {
  products: ScrapedProduct[];
  failure: string | null;
}

/** Fingerprint patches for the hardened profile — the standard headless
 *  tells, applied to every frame before any page script runs. */
const FINGERPRINT_PATCH = () => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  const w = window as unknown as Record<string, unknown>;
  w.chrome ??= { runtime: {} };
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
};

/** Run one full crawl under a single browser profile. */
async function crawlWithProfile(
  url: string,
  site: string,
  profile: BrowserProfile,
  onProgress: ProgressSink,
  options: CsrScrapeOptions = {},
): Promise<CrawlOutcome> {
  const acc = new ProductAccumulator(site, options.onBlock, options);
  let failure: string | null = null;
  const host = new URL(url).hostname;
  const statePath = storageStatePath(host);

  // Real device descriptors give a mutually consistent UA / viewport / DPR /
  // platform / touch surface — the old random-UA + random-viewport pairing
  // was itself an anomaly.
  const device = profile.devicePool
    ? devices[DESKTOP_DEVICE_POOL[Math.floor(Math.random() * DESKTOP_DEVICE_POOL.length)]!]!
    : null;
  const userAgent = device?.userAgent;

  const browser = await sharedBrowser();
  const context = await browser.newContext({
    ...(device ?? {}),
    ...(profile.proxyUrl ? { proxy: { server: profile.proxyUrl } } : {}),
    ...(existsSync(statePath) ? { storageState: statePath } : {}),
  });

  // Cancellation: a disconnected client means nobody is watching — free
  // the context NOW. In-flight page calls reject ("Target closed") and
  // unwind the session body; scrapeCsrSite re-checks before escalating.
  const signal = options.signal;
  const closeOnAbort = () => {
    void context.close().catch(() => undefined);
  };
  signal?.addEventListener('abort', closeOnAbort, { once: true });

  try {
    throwIfAborted(signal);
    if (profile.patchFingerprint) await context.addInitScript(FINGERPRINT_PATCH);
    if (profile.extraHeaders && userAgent) {
      await context.setExtraHTTPHeaders(browserHeaders(userAgent));
    }

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(HANDLER_TIMEOUT_MS);

    // SSRF guard at the network layer: abort ANY request (document, XHR,
    // asset) resolving to a non-public address. A public page must not
    // pivot the browser into the internal network.
    await page.route('**/*', async (route) => {
      if (await isAllowedBrowserRequest(route.request().url())) {
        return route.continue();
      }
      return route.abort('blockedbyclient');
    });
    if (profile.blockHeavyAssets) {
      // fonts & media are pure bandwidth for scraping — block them
      // (images must load: lazy-load pipelines gate content on them)
      await page.route('**/*.{woff,woff2,ttf,otf,eot,mp4,webm,mp3,wav}', (route) =>
        route.abort(),
      );
    }

    // Network interception: CSR storefronts fetch their catalogue from a
    // JSON API — declared data, exact prices, including products that never
    // rendered below the lazy-load fold. Same walker as embedded JSON.
    page.on('response', (res) => {
      void (async () => {
        try {
          if (res.request().resourceType() === 'document') return;
          const ct = res.headers()['content-type'] ?? '';
          if (!ct.includes('json') || !res.ok()) return;
          const body: unknown = await res.json();
          const found = walkForProducts(body, res.url(), site);
          if (found.length === 0) return;
          const added = acc.addProducts(found, res.url());
          if (added > 0) {
            options.onApiEndpoint?.(res.url());
            onProgress(`📡 ${added} deals captured from ${site}'s data API…`);
          }
        } catch {
          /* non-JSON body, detached response, or huge payload — skip */
        }
      })();
    });

    // The whole session body races a watchdog — a hung page must not hold
    // a browser context hostage. Whatever was collected survives.
    await Promise.race([
      (async () => {
        // one retry on navigation failure (crawlee used to give us this)
        for (let navAttempt = 0; navAttempt < 2; navAttempt += 1) {
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            break;
          } catch (e) {
            if (navAttempt === 1) throw e;
            await page.waitForTimeout(1500);
          }
        }
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
        await waitForAnySelector(page, WAIT_SELECTORS, 15_000);
        await dismissOverlays(page); // consent sheets gate scrolling + hydration
        await autoScroll(page); // scrolling also nudges viewport-gated hydration

        // Skeleton SPAs mount product shells long before prices hydrate —
        // don't collect until money-shaped text exists. Universal fallback:
        // if no money appears at all, wait for the DOM to go quiet instead.
        const sawMoney = await page
          .waitForSelector(`text=/${MONEY_TEXT_RE}/`, { timeout: 30_000 })
          .then(() => true)
          .catch(() => false);
        if (sawMoney) {
          await waitForCardStability(page, 15_000);
        } else {
          await waitForDomSettle(page);
          await page.waitForTimeout(1000);
        }

        await acc.collect(page); // state 1: initial listing

        const loadMoreClicks = await drainLoadMore(page, acc, onProgress);
        if (loadMoreClicks === 0) {
          await drainPagination(page, acc, onProgress);
        }
      })(),
      new Promise<void>((r) => setTimeout(r, HANDLER_TIMEOUT_MS)),
    ]);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  } finally {
    signal?.removeEventListener('abort', closeOnAbort);
    // persist cookies/storage so consent dismissal carries across runs
    try {
      mkdirSync(STORAGE_STATE_DIR, { recursive: true });
      await context.storageState({ path: statePath });
    } catch {
      /* best-effort */
    }
    await context.close().catch(() => undefined);
  }

  return { products: acc.values(), failure };
}

/**
 * Scrape a client-rendered page the universal way: walk the browser-profile
 * ladder (stealth → stock), and within each profile exhaust every discovery
 * mechanism — infinite scroll, "Load More" buttons, pagination, child
 * frames — merging every page state into one result.
 *
 * Escalation is driven by one universal signal (previous profile found 0
 * products), never by site identity: any storefront, any stack.
 */
export async function scrapeCsrSite(
  url: string,
  site: string,
  onProgress: ProgressSink = () => {},
  options: CsrScrapeOptions = {},
): Promise<ScrapedProduct[]> {
  // Never launch a browser pointed at a non-public target (SSRF guard).
  await assertPublicUrl(url);
  throwIfAborted(options.signal);
  let lastFailure: string | null = null;

  // Phase 4: a remembered profile starts the ladder mid-way; unknown names
  // fall back to the top (findIndex = -1 → 0).
  const startIdx = Math.max(
    0,
    BROWSER_PROFILES.findIndex((p) => p.name === options.startAtProfile),
  );
  for (let i = startIdx; i < BROWSER_PROFILES.length; i += 1) {
    const profile = BROWSER_PROFILES[i]!;
    options.onProfile?.(profile.name);
    if (i > startIdx) {
      onProgress(
        `🔁 Nothing surfaced — relaunching ${site} with a ${profile.label} browser fingerprint…`,
      );
    }
    const { products, failure } = await crawlWithProfile(url, site, profile, onProgress, options);
    // Cancelled mid-crawl: stop the ladder — no escalation, no learning.
    if (options.signal?.aborted) throw new AbortedError();
    if (products.length > 0) return products;
    if (failure) lastFailure = failure;
  }

  if (lastFailure) throw new Error(lastFailure);
  return [];
}

/**
 * Discovery's Tier-4 hook (D3): a homepage that was an SPA shell over HTTP
 * gets ONE real render — the HTML the client-side app actually mounts,
 * plus the JSON API URLs it hit on the way (a campaign endpoint on the
 * wire outranks every keyword guess; the orchestrator scores them as
 * source 'network').
 *
 * NOT a scrape: no accumulation, no pagination drain — render, settle,
 * read, close. Reuses the ONE shared browser with a fresh context (same
 * isolation as a fresh browser, a fraction of the cost), and the same
 * network-layer SSRF guard every browser path gets.
 */
export async function renderPageForDiscovery(
  url: string,
  signal?: AbortSignal,
): Promise<{ html: string; seenApiUrls: string[] } | null> {
  await assertPublicUrl(url); // never launch a browser at a non-public target
  throwIfAborted(signal);

  const device = devices[
    DESKTOP_DEVICE_POOL[Math.floor(Math.random() * DESKTOP_DEVICE_POOL.length)]!
  ]!;
  const browser = await sharedBrowser();
  const context = await browser.newContext({ ...device });
  const closeOnAbort = () => {
    void context.close().catch(() => undefined);
  };
  signal?.addEventListener('abort', closeOnAbort, { once: true });

  const seenApiUrls: string[] = [];
  try {
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(HANDLER_TIMEOUT_MS);

    // SSRF guard at the network layer: a public page must not pivot the
    // browser into the internal network.
    await page.route('**/*', async (route) => {
      if (await isAllowedBrowserRequest(route.request().url())) {
        return route.continue();
      }
      return route.abort('blockedbyclient');
    });
    // Fonts & media are pure bandwidth; images must load (banner alt text
    // is a harvest source).
    await page.route('**/*.{woff,woff2,ttf,otf,eot,mp4,webm,mp3,wav}', (route) =>
      route.abort(),
    );

    page.on('response', (res) => {
      try {
        if (res.request().resourceType() === 'document') return;
        const ct = res.headers()['content-type'] ?? '';
        if (!ct.includes('json') || !res.ok()) return;
        if (seenApiUrls.length < 25 && !seenApiUrls.includes(res.url())) {
          seenApiUrls.push(res.url());
        }
      } catch {
        /* headers gone mid-flight — skip */
      }
    });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch {
      // A nav timeout still leaves whatever the app already mounted —
      // Tier 4 harvests partial DOMs rather than nothing.
    }
    throwIfAborted(signal);
    await dismissOverlays(page);
    await waitForDomSettle(page);
    await autoScroll(page, 2); // wake lazy mega-menus / hero carousels

    return { html: await page.content(), seenApiUrls };
  } catch (e) {
    if (e instanceof AbortedError || signal?.aborted) throw new AbortedError();
    return null; // a failed render degrades Tier 4 to the cheap tiers' yield
  } finally {
    signal?.removeEventListener('abort', closeOnAbort);
    await context.close().catch(() => undefined);
  }
}
