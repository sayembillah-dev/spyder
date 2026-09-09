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
