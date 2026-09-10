/**
 * Every runtime tunable in one place, env-driven. This is the ONLY module in
 * the server allowed to read process.env — if a knob isn't here, it doesn't
 * exist. See .env.example for documentation of every key.
 */
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const config = {
  port: num(process.env.PORT, 4000),
  maxUrls: num(process.env.MAX_URLS, 10),

  /**
   * Dev escape hatch for the SSRF guard: allow loopback/private/link-local
   * scrape targets (e.g. a local test shop on :8080). Default OFF. When ON
   * it is loudly logged at boot. Never enable on a deployed instance.
   */
  allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === 'true',

  detect: {
    timeoutMs: num(process.env.DETECT_TIMEOUT_MS, 12_000),
    concurrency: num(process.env.DETECT_CONCURRENCY, 4),
  },
  scrape: {
    concurrency: num(process.env.SCRAPE_CONCURRENCY, 2),
    /** Browsers are heavy AND hosts dislike parallel hammering (Phase 5). */
    perHostConcurrency: num(process.env.PER_HOST_CONCURRENCY, 1),
    navTimeoutSecs: num(process.env.NAV_TIMEOUT_SECS, 45),
    handlerTimeoutSecs: num(process.env.HANDLER_TIMEOUT_SECS, 300),
    scrollRounds: num(process.env.SCROLL_ROUNDS, 14),
    maxLoadMoreClicks: num(process.env.MAX_LOAD_MORE_CLICKS, 12),
    maxStaleClicks: num(process.env.MAX_STALE_CLICKS, 2),
    maxPages: num(process.env.MAX_PAGES, 5),
  },
  // ⚠️ These two interact: the per-state cap applies to EACH page state's
  // extraction, the total cap to the merged result. perState must be ≥ total
  // or multi-page scrapes silently truncate each state before merging.
  caps: {
    perState: num(process.env.MAX_PRODUCTS_PER_STATE, 200),
    total: num(process.env.MAX_PRODUCTS_TOTAL, 200),
  },
  match: {
    threshold: num(process.env.MATCH_THRESHOLD, 0.5),
    sameSitePenalty: num(process.env.SAME_SITE_PENALTY, 0.15),
    maxPriceRatio: num(process.env.MAX_PRICE_RATIO, 5),
  },
  quality: {
    /** Below this score the ladder escalates to the next rung and the
     *  better-scoring attempt wins. 0 products always scores 0. */
    escalateBelow: num(process.env.QUALITY_ESCALATE_BELOW, 0.35),
  },
  cache: {
    /** Per-host strategy cache: entries older than this are weak hints —
     *  used, but evicted on the first failure. */
    ttlDays: num(process.env.STRATEGY_CACHE_TTL_DAYS, 7),
  },
  /** Deal-page discovery (DISCOVERY_PLAN). Bounded best-first search over one
   *  registrable domain — every cap is a hard cap, exhaustion is a normal
   *  reported outcome, never an error. */
  discovery: {
    maxFetches: num(process.env.DISCOVERY_MAX_FETCHES, 20),
    maxDurationMs: num(process.env.DISCOVERY_MAX_MS, 45_000),
    maxCandidates: num(process.env.DISCOVERY_MAX_CANDIDATES, 120),
    maxVerify: num(process.env.DISCOVERY_MAX_VERIFY, 6),
    /** Top-K verified candidates that proceed to the full scrape ladder. */
    maxScrape: num(process.env.DISCOVERY_MAX_SCRAPE, 3),
    /** "enough()" for tier early-exit: this many candidates scoring ≥ 0.55. */
    minCandidates: num(process.env.DISCOVERY_MIN_CANDIDATES, 4),
    maxExpandDepth: num(process.env.DISCOVERY_MAX_DEPTH, 1),
    memoTtlHours: num(process.env.DISCOVERY_MEMO_TTL_HOURS, 12),

    /** D4.2 verification thresholds — the tuning surface, env from day one. */
    verify: {
      /** Fewer products than this ⇒ 'not-a-listing' (blog, landing page). */
      minProducts: num(process.env.DISCOVERY_VERIFY_MIN_PRODUCTS, 3),
      /** Full accept needs at least this many products… */
      acceptProducts: num(process.env.DISCOVERY_VERIFY_ACCEPT_PRODUCTS, 8),
      /** …plus quality ≥ escalateBelow, plus one of: dealDensity ≥ this… */
      densityAccept: num(process.env.DISCOVERY_VERIFY_DENSITY_ACCEPT, 0.3),
      /** Below this density AND a weak prior ⇒ 'no-discounts' reject. */
      densityReject: num(process.env.DISCOVERY_VERIFY_DENSITY_REJECT, 0.05),
      /** …or a countdown timer… or a prior at least this strong. */
      strongPrior: num(process.env.DISCOVERY_VERIFY_STRONG_PRIOR, 0.8),
      rejectPriorFloor: num(process.env.DISCOVERY_VERIFY_REJECT_PRIOR_FLOOR, 0.75),
      /** Verification extraction cap — enough to measure, cheap to get. */
      productCap: num(process.env.DISCOVERY_VERIFY_PRODUCT_CAP, 60),
    },

    /** D9 graceful degradation: when NOTHING clears the accept bar, the
     *  discounts are scattered across ordinary category listings — verify a
     *  few of the best unverified nav/body anchors and keep the deal-bearing
     *  ones, explicitly marked 'fallback:category-listing'. */
    fallback: {
      /** At most this many extra verifications for the fallback ladder. */
      maxVerify: num(process.env.DISCOVERY_FALLBACK_MAX_VERIFY, 3),
      /** A category listing must be at least this deal-dense to be kept. */
      minDensity: num(process.env.DISCOVERY_FALLBACK_MIN_DENSITY, 0.15),
    },

    // registry (D6) + scheduler (D10)
    registryMax: num(process.env.DISCOVERY_REGISTRY_MAX, 5_000),
    staleAfterHours: num(process.env.DISCOVERY_STALE_AFTER_HOURS, 24),
    /** AUTO_REFRESH: unattended background fetching — OFF by default. */
    autoRefresh: process.env.AUTO_REFRESH === 'true',
    refreshTickMs: num(process.env.REFRESH_TICK_MS, 300_000),
    refreshPerTick: num(process.env.REFRESH_PER_TICK, 5),
    refreshMinHours: num(process.env.REFRESH_MIN_HOURS, 1),
    refreshMaxHours: num(process.env.REFRESH_MAX_HOURS, 168), // 7 days
    /** D10: an unattended loop launching Chromium is how you find out your
     *  box has 8 GB — hard cap on browser-rung scrapes per hour. */
    refreshBrowserPerHour: num(process.env.REFRESH_BROWSER_PER_HOUR, 6),
    /** D10: this many consecutive check failures across DIFFERENT domains
     *  means the network is down, not the sites — pause instead of
     *  hammering. */
    refreshPauseAfterFailures: num(process.env.REFRESH_PAUSE_AFTER_FAILURES, 3),
    refreshPauseMs: num(process.env.REFRESH_PAUSE_MS, 15 * 60_000),

    /**
     * Escape hatch for merchants hosting campaigns on a SEPARATE brand
     * domain: allow discovered URLs outside the input's registrable domain.
     * Default OFF (this is the SSRF surface that matters most). Loudly
     * logged when ON.
     */
    allowCrossSite: process.env.DISCOVERY_ALLOW_CROSS_SITE === 'true',
    /** Discovery fetches are single cheap GETs, not sustained crawls — run
     *  below the scrape delay window. */
    hostDelayMs: num(process.env.DISCOVERY_HOST_DELAY_MS, 300),
    /** Optional JSON file extending the D2 lexicon (add a language without a
     *  code change). Absent → built-in lexicon only. */
    lexiconPath: process.env.DISCOVERY_LEXICON_PATH || null,
  },
  net: {
    /** Proxy server URL for the 'proxied' browser rung (http://user:pass@host:port).
     *  Absent → the rung is not in the ladder at all. */
    proxy: process.env.PROXY_URL || null,
    /** Jittered inter-request delay window per host (ms). */
    minDelayMs: num(process.env.HOST_MIN_DELAY_MS, 500),
    maxDelayMs: num(process.env.HOST_MAX_DELAY_MS, 1_500),
    /** Honour robots.txt Disallow rules. Off by default; when on, use
     *  ROBOTS_OVERRIDE=true to bypass per-run consciously. */
    respectRobots: process.env.RESPECT_ROBOTS === 'true',
    robotsOverride: process.env.ROBOTS_OVERRIDE === 'true',
  },
} as const;
