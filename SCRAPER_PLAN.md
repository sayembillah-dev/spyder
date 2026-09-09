# FlashDeal Radar — Robustness & Dynamism Plan

Engineering plan for turning the current scraper into a self-improving,
production-safe extraction engine — without breaking the "universal, not
site-specific" principle that makes it worth keeping.

**Baseline:** commit `5d0980d` + working-tree changes. Typecheck clean. No tests.
**Guiding constraint:** every capability must be a general strategy. No `if (host === 'daraz')`.
Site knowledge is permitted only when it is **learned at runtime and self-correcting**, never hardcoded.

---

## Table of contents

- [Status summary](#status-summary)
- [Phase 0 — Safety net (blocks everything else)](#phase-0--safety-net)
- [Phase 1 — Correctness & safety quick wins](#phase-1--correctness--safety-quick-wins)
- [Phase 2 — Extraction coverage (the big accuracy jump)](#phase-2--extraction-coverage)
- [Phase 3 — Quality scoring (the measurement layer)](#phase-3--quality-scoring)
- [Phase 4 — Memory & dynamism](#phase-4--memory--dynamism)
- [Phase 5 — Anti-block & performance](#phase-5--anti-block--performance)
- [Phase 6 — Client & UX](#phase-6--client--ux)
- [Dependency graph](#dependency-graph)
- [Risk register](#risk-register)

---

## Status summary

| # | Item | Phase | Effort | Status |
|---|---|---|---|---|
| 1 | Unify three merge implementations | — | 1h | ✅ **done** |
| 2 | Price-ratio veto in matcher | — | 15m | ✅ **done** |
| 3 | Currency guard in matcher | 1 | 10m | ✅ **done** |
| 4 | Vitest + golden fixtures + CI | 0 | 1d | ✅ **done** |
| 5 | `config.ts` (env-driven tunables) | 1 | 2h | ✅ **done** |
| 6 | SSRF guard | 1 | 3h | ✅ **done** |
| 7 | Block detection (`status: 'blocked'`) | 1 | 2h | ✅ **done** |
| 8 | Honest build script | 1 | 15m | ✅ **done** |
| 9 | JSON-LD + microdata extraction | 2 | 1d | ✅ **done** |
| 10 | Generalized JSON walker (App Router, Nuxt, Apollo) | 2 | 1d | ✅ **done** |
| 11 | Network interception in browser rung | 2 | 1.5d | ✅ **done** |
| 12 | Extraction quality scoring | 3 | 1d | ✅ **done** |
| 13 | Escalate on quality, not just count | 3 | 3h | ✅ **done** |
| 14 | Per-host strategy cache | 4 | 1.5d | ✅ **done** |
| 15 | Selector + endpoint learning | 4 | 4h | ✅ **done** |
| 16 | Fingerprint hardening | 5 | 1d | ✅ **done** |
| 17 | Per-host rate limiting | 5 | 4h | ✅ **done** |
| 18 | Shared browser instance / drop crawlee | 5 | 1d | ✅ **done** |
| 19 | Adaptive waits | 5 | 4h | ✅ **done** |
| 20 | SSE reconnect + cancellation | 6 | 4h | ✅ **done** |
| 21 | Confidence surfaced in UI | 6 | 3h | ✅ **done** |

Rough total: **~12 working days**. Phases 0–2 alone (~4 days) deliver most of the value.

---

## Phase 0 — Safety net

> **Nothing else in this plan should be started before this is done.** Every
> item below Phase 0 changes tuned heuristics whose failure mode is *silent* —
> you get fewer products, not an exception.

### 0.1 Test harness

```bash
npm i -D vitest -w server
```

`server/vitest.config.ts` — node environment, no globals needed.
Add to root `package.json`: `"test": "npm run test -w server"`.

### 0.2 Golden HTML fixtures

The core extraction functions are **pure and network-free**. Exploit that.

```
server/test/
  fixtures/
    chaldal-popular.html          # captured page.content()
    chaldal-popular.expected.json # snapshot of extracted products
    pickaboo-listing.html
    pickaboo-listing.expected.json
    othoba-hydrated.html          # JS-hydrated prices
    daraz-flash.html              # load-more listing
    tailwind-nosemantic.html      # exercises extractFromStructure
    jsonld-shopify.html           # Phase 2 target
    nextjs-approuter.html         # Phase 2 target
  extractor.test.ts
  matcher.test.ts
  merge.test.ts
  price.test.ts
  pagination.test.ts
```

**Capture script** — `server/scripts/capture-fixture.ts`:

```ts
// npm run fixture:capture -- https://site/deals name
// Renders with the real CSR pipeline, writes both the HTML and the
// current extraction output as the expected snapshot. Review the JSON
// by hand before committing — the snapshot IS the specification.
```

Rules:
- Fixtures are committed. They are the regression suite.
- A snapshot change must be reviewed as a diff, never blind-updated.
- Every bug fixed from here on gets a fixture first.

### 0.3 Unit tests for the heuristics

Test the rules directly, not just end-to-end:

| Function | Cases that must be locked down |
|---|---|
| `amountsFromPriceText` | `"Hoco EQ27"` → `[]`, `"176 Sold"` → `[]`, `"৳176/month"` → EMI excluded, `"1,299 Tk"` → `[1299]`, Bangla digits `"৳১,২৯৯"` → `[1299]` |
| `extractProductsFromHtml` | struck-through original not chosen as deal; card with only an original price; nested card selectors don't double-count |
| `findNextPageUrl` | `rel="next"`, `?page=N` increment, `/page/N/`, disabled-next suppression, `aria-disabled` on a navigable link |
| `buildComparisonGroups` | model-token veto, price-ratio veto, currency guard, single-site groups dropped |
| `ProductMerger` | dedupe, image/price backfill, cross-page link upgrade, cap behaviour |

### 0.4 CI

`.github/workflows/ci.yml` — on push/PR: `npm ci && npm run typecheck && npm test`.

**Acceptance:** `npm test` green; deliberately breaking `STRUCT_TEXT_MAX` or a
`CARD_SELECTOR` entry causes a **red test**, not a silent product-count drop.

---

## Phase 1 — Correctness & safety quick wins

Small, independent, no ordering constraints between them.

### 1.1 Currency guard in the matcher

`buildComparisonGroups` never compares `currency`. Because `detectCurrency`
defaults to `'BDT'` for anything unrecognized, a USD listing can silently join a
BDT group and produce a meaningless `savings`.

```ts
// next to the price-ratio veto in the group loop
if (g.items[0]!.currency !== p.currency) continue;
```

Longer term, if genuine multi-currency comparison is wanted, normalize to a base
currency at extraction time and keep the original for display. Until then, the
guard is correct behaviour.

### 1.2 `server/src/config.ts`

Every tunable is currently a module-level const across six files, and
`process.env` appears exactly **once** in the whole server (PORT). The README's
"Tuning" section amounts to "go edit these five files."

```ts
const num = (v: string | undefined, d: number) => {
  const n = Number(v); return Number.isFinite(n) ? n : d;
};

export const config = {
  port: num(process.env.PORT, 4000),
  maxUrls: num(process.env.MAX_URLS, 10),

  detect: {
    timeoutMs: num(process.env.DETECT_TIMEOUT_MS, 12_000),
    concurrency: num(process.env.DETECT_CONCURRENCY, 4),
  },
  scrape: {
    concurrency: num(process.env.SCRAPE_CONCURRENCY, 2),
    perHostConcurrency: num(process.env.PER_HOST_CONCURRENCY, 1), // Phase 5
    navTimeoutSecs: num(process.env.NAV_TIMEOUT_SECS, 45),
    handlerTimeoutSecs: num(process.env.HANDLER_TIMEOUT_SECS, 300),
    scrollRounds: num(process.env.SCROLL_ROUNDS, 14),
    maxLoadMoreClicks: num(process.env.MAX_LOAD_MORE_CLICKS, 12),
    maxStaleClicks: num(process.env.MAX_STALE_CLICKS, 2),
    maxPages: num(process.env.MAX_PAGES, 5),
  },
  // ⚠️ These two interact: the extractor cap applies PER PAGE STATE, the
  // total cap applies to the merged result. perState must be ≥ total or
  // multi-page scrapes silently truncate each state before merging.
  caps: {
    perState: num(process.env.MAX_PRODUCTS_PER_STATE, 200),
    total: num(process.env.MAX_PRODUCTS_TOTAL, 200),
  },
  match: {
    threshold: num(process.env.MATCH_THRESHOLD, 0.5),
    sameSitePenalty: num(process.env.SAME_SITE_PENALTY, 0.15),
    maxPriceRatio: num(process.env.MAX_PRICE_RATIO, 5),
  },
} as const;
```

Note the cap bug this surfaces: today `MAX_PRODUCTS_PER_SITE = 150` (per state)
is **below** `MAX_PRODUCTS_TOTAL = 200`, so each page state is truncated by
arbitrary `Map` insertion order before it ever reaches the merger. Raising
`perState` to 200 fixes it.

Ship a `.env.example` documenting every key.

### 1.3 SSRF guard — **required before this binds to anything but loopback**

`POST /api/scrape` accepts arbitrary URLs; axios *and* a headless Chromium
fetch them; the response content is echoed back through extracted products and
error messages. `normalizeUrl` only checks the hostname contains a dot. Today
`http://169.254.169.254/latest/meta-data/`, `http://localhost:6379` and
`http://10.0.0.5/admin` all go through. `maxRedirects: 5` follows redirects
blindly, so a public URL can 302 into any of them.

`server/src/utils/ssrf.ts`:

```ts
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export class BlockedTargetError extends Error {}

/** Reject anything not routable on the public internet. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new BlockedTargetError(`Unsupported protocol: ${u.protocol}`);
  }
  const results = await lookup(u.hostname, { all: true });
  for (const { address } of results) {
    const parsed = ipaddr.parse(address);
    const range = parsed.range(); // 'private' | 'loopback' | 'linkLocal' | 'uniqueLocal' | ...
    if (range !== 'unicast') {
      throw new BlockedTargetError(`Refusing non-public target (${range}): ${u.hostname}`);
    }
  }
  return u;
}
```

Wire it in:
- `fetchHtml` — set `maxRedirects: 0` and follow hops manually, re-validating each `Location`
- `scrapeCsrSite` — validate before launching the browser, and add a Playwright
  route handler that aborts any request resolving to a private address
- Both API handlers — validate up front so a bad URL is a `400`, not a 500

Note the residual TOCTOU window (DNS could re-resolve between check and fetch).
Closing it fully needs a pinned-IP agent; the route-level abort is the pragmatic
mitigation for a self-hosted tool.

### 1.4 Block detection

A Cloudflare interstitial rendering "Checking your browser" yields zero products
and is **indistinguishable** from a page with no deals. You cannot currently
tell "site has nothing" from "we got walled."

```ts
const BLOCK_SIGNALS = new RegExp(
  [
    'just a moment', 'checking your browser', 'attention required',
    'access denied', 'verify you are human', 'unusual traffic',
    'captcha', 'cf-browser-verification', 'are you a robot', 'request blocked',
  ].join('|'),
  'i',
);

export function detectBlock(html: string, status?: number): string | null {
  if (status === 403 || status === 429) return `HTTP ${status}`;
  const head = html.slice(0, 20_000);            // banner is always near the top
  const m = head.match(BLOCK_SIGNALS);
  return m ? `challenge page ("${m[0]}")` : null;
}
```

Add `'blocked'` to `SiteReport['status']` and a `blockReason?: string`. Report it
distinctly in the SSE stream and the dashboard. This turns the most confusing
failure mode into a legible one, and it is a prerequisite for sane Phase 4 cache
invalidation (a block must **not** poison the learned strategy).

### 1.5 Honest build script

`server`'s `build` is `tsc --noEmit` — byte-identical to `typecheck`. Root
`npm run build` emits no server output, so "production" runs through `tsx`.
Either emit real JS (`tsc` with `outDir`, `start` → `node dist/index.js`) or
rename the script to `typecheck` and stop pretending.

---

## Phase 2 — Extraction coverage

The largest accuracy gains available. All three items are **additive strategies**
inside the existing extractor ladder — low architectural risk, guarded by Phase 0
fixtures.

### 2.1 JSON-LD and microdata — the biggest single gap

The extractor knows `__NEXT_DATA__`, DOM selectors, and structural inference. It
does **not** read schema.org data, which is far more universal than
`__NEXT_DATA__` and is emitted by Shopify, WooCommerce, Magento, BigCommerce and
every SEO plugin in existence.

Prices from these sources are **declared, not inferred** — no currency anchoring,
no `Math.min` guessing, no `"176 Sold"` contamination possible.

**a) JSON-LD** — `<script type="application/ld+json">`:

```ts
// Handle @graph, arrays, and nested ItemList/itemListElement/offers.
// Targets: @type Product | ItemList | OfferCatalog
// Price:   offers.price / offers.lowPrice / offers.priceSpecification.price
// Currency: offers.priceCurrency  ← authoritative, kills the BDT default guess
// Also read: availability, sku, brand, aggregateRating
```

**b) Microdata** — you already match `[itemtype*="Product"]` as a *card
selector* but never read the `itemprop` attributes inside it:

```ts
// itemprop="name"          → title
// itemprop="price"         → prefer the `content` attribute over text
// itemprop="priceCurrency" → currency
// itemprop="image" / "url" → media + link
```

**c) OpenGraph** — `product:price:amount` / `og:price:amount` for single-product pages.

**New extractor ladder order:**

```
① JSON-LD          (declared, exact)
② Microdata        (declared, exact)
③ Embedded JSON    (§2.2 — strong, inferred shape)
④ DOM selectors    (heuristic)
⑤ Structural       (last resort)
```

Keep the existing lazy-cost discipline: rungs ③–⑤ only run when everything above
them came up empty. Merge all yields through `ProductMerger` so a JSON-LD product
missing an image still gets one backfilled from the DOM pass.

### 2.2 Generalize the JSON walker — you are blind to modern Next.js

`__NEXT_DATA__` exists only in **Pages Router**. Next.js App Router (default
since 13) streams data via `self.__next_f.push([...])` inline scripts — there is
no `__NEXT_DATA__` element at all. Any recently-built Next.js storefront
**silently skips your strongest extraction strategy today.**

`extractFromNextData` already has an excellent site-agnostic core:
`looksLikeProduct`, `mapJsonProduct`, and the "≥50% of an array is
product-shaped" density test. The only thing wrong with it is the hard-wired
`$('#__NEXT_DATA__')` selector.

```ts
/** Every JSON payload a page might carry, framework-agnostic. */
function* jsonSources($: cheerio.CheerioAPI): Generator<unknown> {
  // 1. any declared JSON script block
  $('script[type="application/json"], script[type="application/ld+json"]')
    .each(/* JSON.parse, tolerate failures */);

  // 2. hydration globals: window.__NUXT__, __INITIAL_STATE__,
  //    __APOLLO_STATE__, __PRELOADED_STATE__, __INITIAL_DATA__
  //    → regex the assignment, balance-match the object literal

  // 3. Next.js App Router flight data: self.__next_f.push([1,"..."])
  //    → concatenate the pushed string chunks, then parse embedded JSON
}
```

Point the existing walker at every source. One function-signature change; covers
Nuxt, Vue, Redux, Apollo and modern Next.js at once. This is the change that most
directly extends the universality principle you already committed to.

### 2.3 Network interception in the browser rung

The CSR path renders and scrapes the **DOM**. But nearly every CSR storefront
fetches its catalogue from a JSON API — which you currently ignore entirely.

```ts
page.on('response', async (res) => {
  const ct = res.headers()['content-type'] ?? '';
  if (!ct.includes('json') || !res.ok()) return;
  if (res.request().resourceType() === 'document') return;
  try {
    const body = await res.json();
    const found = walkForProducts(body, res.url(), site); // reuse §2.2 walker
    if (found.length) {
      merger.add(found, res.url());
      capturedEndpoints.push(res.url());   // ← feeds Phase 4
    }
  } catch { /* non-JSON body or detached */ }
});
```

What this buys:
- **Exact prices**, no DOM heuristics at all
- Products that never rendered (below the lazy-load fold)
- **The API endpoint itself** — usually `?page=N` or a cursor you can hit with
  plain axios later, skipping the browser entirely on subsequent runs

The machinery already exists; you are only changing what you feed it. Combined
with Phase 4, this is what makes repeat runs fast *and* reliable.

**Acceptance for Phase 2:** each new strategy demonstrably adds products on its
target fixture, and **no existing fixture regresses**. That guarantee is exactly
what Phase 0 exists to provide.

---

## Phase 3 — Quality scoring

Escalation currently triggers on `products.length === 0`. That is too coarse: a
page yielding 8 pieces of garbage (nav items with prices, a "related products"
sidebar) stops the ladder, satisfied. This is the root cause of silent
degradation — **a partial scrape looks exactly like a complete one.**

### 3.1 Score every result set

```ts
export interface ExtractionQuality {
  score: number;              // 0..1
  productCount: number;
  pctWithRealLink: number;    // productUrl !== the page fallback
  pctWithImage: number;
  pctWithOriginalPrice: number;
  claimedTotal: number | null; // parsed from "1,234 products found"
  coverage: number | null;     // productCount / claimedTotal
  flags: string[];             // 'all-prices-identical', 'extreme-variance', …
}
```

Signals, and why each one matters:

| Signal | Detects |
|---|---|
| % with a **real** product link | Structural inference grabbing containers instead of cards. Cheap to measure now — `ProductMerger` already tracks `pageUrls`. |
| % with image | Cards matched before lazy-load resolved |
| % with `originalPrice` | Deal pages should mostly show a strike-through; near-zero suggests wrong elements matched |
| All prices identical | Matched a template/placeholder, not real data |
| Extreme price variance | Mixed cards + banners + unrelated widgets |
| **Coverage vs. claimed total** | The strongest signal available. Most listings print "1,234 products" — parse it. 12 of 1,234 means pagination silently failed. |

### 3.2 Escalate on quality, not just count

```ts
// scraperService — replace `products.length === 0`
const quality = scoreExtraction(products, pageUrl, html);
if (quality.score < config.quality.escalateBelow) {
  // try the next rung; keep whichever attempt scored highest
}
```

Keep the **best-scoring** attempt rather than the first non-empty one. Add
`quality` to `SiteReport` and the SSE `done` payload.

**Acceptance:** a fixture that yields plausible-but-wrong output (sidebar
products) scores below threshold and triggers escalation, where today it stops the
ladder.

---

## Phase 4 — Memory & dynamism

> This is what makes the engine *dynamic* in the strongest sense: it gets faster
> and more accurate the more you use it, with **zero per-site code**.

Today every run rediscovers everything from scratch — re-detect, re-walk the
ladder, re-learn that this host needs `browser-clean`.

### 4.1 Per-host strategy cache

```ts
interface HostStrategy {
  host: string;
  renderType: RenderType;
  method: ScrapeMethod;
  profile: BrowserProfileName | null;
  extractionStrategy: 'json-ld' | 'microdata' | 'embedded-json' | 'dom' | 'structure' | 'network';
  cardSelector: string | null;   // learned, §4.2
  apiEndpoint: string | null;    // learned from §2.3
  bestQuality: number;
  lastSuccessAt: number;
  successCount: number;
  consecutiveFailures: number;
}
```

Storage: a JSON file under `server/.cache/strategies.json` (gitignored), or
SQLite if it outgrows that. No external dependency needed at this scale.

**The critical design rule — a hint, never a rule:**

```
1. Cache hit → start at the remembered rung (skip detection entirely).
2. Result scores ≥ threshold  → update cache (bump successCount), done.
3. Result scores below         → discard the shortcut, walk the FULL ladder
                                 from rung 0, overwrite the cache with whatever wins.
4. consecutiveFailures ≥ 3     → evict the entry entirely.
5. Entry older than N days     → treat as a weak hint; re-validate.
6. `status: 'blocked'` (§1.4)  → do NOT touch the cache. A block says nothing
                                 about which strategy is correct.
```

This preserves the self-healing property exactly. Nothing is hardcoded;
everything is learned and independently re-derivable. A site redesign costs one
slow run, then the cache re-converges.

**Payoff:** a 90-second browser crawl becomes a ~3-second HTML fetch on repeat
runs — the difference between a demo and a tool you actually use.

### 4.2 Selector and endpoint learning

Two facts you already discover and then throw away:

- When `extractFromStructure` succeeds, you **know** which class names delimited
  the cards. Persist the winning selector; try it first next run (as an extra
  entry in the DOM rung's bank, scoped to that host).
- When §2.3 captures a product API, persist the endpoint. Next run, try
  `axios.get(endpoint)` **before** launching a browser at all. Many sites collapse
  from rung 2 to rung 1 permanently.

Both are learned-at-runtime, so the universality constraint holds.

---

## Phase 5 — Anti-block & performance

### 5.1 Fingerprint hardening

The current ladder is two headless Chromium profiles from one IP, masking none of
the standard tells.

- Add `playwright-extra` + `puppeteer-extra-plugin-stealth`; or at minimum patch
  `navigator.webdriver`, `chrome.runtime`, and the plugin/language surface.
- **Use Playwright's `devices[...]` descriptors instead of hand-rolled UA +
  viewport.** This matters more than it sounds: a random desktop UA paired with a
  random viewport is *itself* an anomaly, because real devices have mutually
  consistent UA / viewport / DPR / platform / touch. The current randomization
  may be making you **more** detectable, not less.
- Persist cookies + storage state per host so consent dismissal carries across runs.
- Add a **proxy rung** to `BROWSER_PROFILES` — this is precisely the extension
  point that design was built for, and it stays a pure config addition:

```ts
{ name: 'proxied', label: 'proxied', randomUa: true, extraHeaders: true,
  blockHeavyAssets: true, randomViewport: false, proxy: config.proxy }
```

### 5.2 Per-host rate limiting

`SCRAPE_CONCURRENCY = 2` is **global**, so two URLs on the same host hammer it
simultaneously, each firing up to 12 load-more clicks. Bans are the #1 cause of a
scraper "randomly breaking."

- Token bucket keyed by hostname; `perHostConcurrency: 1` by default
- Jittered inter-request delay (500–1500 ms)
- Honour `Retry-After` on 429 instead of the current blind retry
- Optional `robots.txt` check with an explicit override flag

### 5.3 One shared browser

Each profile attempt constructs a new `PlaywrightCrawler` and launches a fresh
Chromium. A 10-URL run with escalations can launch **20 browsers**.

Replace with a module-level singleton `browser` and a fresh `context` per
attempt — identical isolation, a fraction of the cost, and it removes a common
flaky-failure source under memory pressure.

This also **retires `crawlee`**: you currently pull a full crawling framework
(queues, autoscaling, session pools, dataset storage) to open a single page with
`maxRequestsPerCrawl: 1`, and then disable its storage. Raw
`playwright.chromium.launch()` is ~20 lines and drops a heavy dependency.

### 5.4 Adaptive waits

Replace fixed `waitForTimeout(1500)` / `waitForTimeout(2500)` sleeps with
`waitForFunction` polling for **card-count stability** against a deadline:

```ts
await page.waitForFunction(
  (sel) => {
    const n = document.querySelectorAll(sel).length;
    const w = window as any;
    const stable = n === w.__lastCount ? (w.__stableTicks ?? 0) + 1 : 0;
    w.__lastCount = n; w.__stableTicks = stable;
    return stable >= 3;
  },
  CARDS_SELECTOR,
  { timeout: 15_000, polling: 400 },
).catch(() => {});
```

Faster on fast sites, more reliable on slow ones. The current fixed sleeps are
simultaneously too long and too short.

---

## Phase 6 — Client & UX

### 6.1 SSE reconnect and cancellation

`api.ts` `onerror` fires on any transport hiccup and immediately closes +
declares a fatal error — defeating both EventSource's native reconnect and the
server's own `retry: 3000`. A 4-minute scrape that blips once loses everything.

- Allow 2–3 reconnect attempts before declaring fatal
- Thread an `AbortSignal` from the request into the crawl so closing the stream
  actually stops the work. Today `closeRef.current?.()` closes the client socket
  while the server keeps driving Chromium for up to 300s, burning a browser slot.
- Guard the `JSON.parse` calls in the event listeners

### 6.2 Surface confidence

Show the Phase 3 quality score and the Phase 1 block status per site in
`StatusFeed`: a green/amber/red dot with a tooltip ("42 products, 18% missing
links — low confidence"), and a distinct **Blocked** state. Without this, all the
measurement work in Phase 3 stays invisible.

---

## Dependency graph

```
Phase 0 (tests + fixtures)
   │  ← blocks everything; heuristic changes are unverifiable without it
   ├──────────────┬──────────────────┐
   ▼              ▼                  ▼
Phase 1        Phase 2            Phase 5.2/5.3/5.4
(quick wins)   (extraction)       (perf — independent)
   │              │
   │  §1.4 block  │
   │  detection   │
   └──────┬───────┘
          ▼
      Phase 3 (quality scoring)
          │  ← cache needs a score to know what "worked" means
          ▼
      Phase 4 (strategy cache)
          │  §2.3 endpoints + §4.2 selectors feed this
          ▼
      Phase 6 (surface it)
```

**Critical path:** 0 → 2 → 3 → 4. Phase 1 and Phase 5 can run in parallel with
anything once Phase 0 lands.

---

## Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Fixtures go stale as sites redesign | Tests assert obsolete behaviour | Fixtures test **the extractor**, not the live site. Refresh deliberately, review snapshot diffs as code. |
| New extraction strategies regress working sites | Silent product loss | Phase 0 gate: no strategy merges unless every existing fixture holds. |
| Strategy cache locks in a bad choice | A site degrades and stays degraded | Quality-gated writes, `consecutiveFailures` eviction, full-ladder fallback, TTL, and never caching on `blocked`. |
| Stealth escalation reads as adversarial | Ethical + IP-ban exposure | Per-host rate limiting, robots.txt check, honest UA option. Stealth is for *reliability on public listings*, not for defeating access controls. |
| SSRF fix breaks localhost dev targets | Dev friction | `ALLOW_PRIVATE_TARGETS=true` escape hatch, default off, loudly logged. |
| Scope creep across 6 phases | Nothing ships | Phases 0–2 (~4 days) are independently valuable. Stop there if needed. |

---

## Definition of done

- `npm test` green in CI on every push; fixtures cover all five extraction strategies
- No `process.env` reads outside `config.ts`
- SSRF guard rejects private/loopback/link-local targets, redirects included
- A blocked site reports `status: 'blocked'`, never `ok` with 0 products
- JSON-LD, microdata and App Router payloads each demonstrably extract on fixtures
- `SiteReport` carries a quality score; the dashboard renders confidence per site
- A second run against a known host skips detection and starts at the learned rung
- Zero site-specific branches anywhere in `server/src`
