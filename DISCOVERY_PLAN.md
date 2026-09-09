# Deal-Page Discovery — Engineering Plan

Turning the scraper from *"give me a URL"* into *"give me a domain"*.

**Companion to** [SCRAPER_PLAN.md](SCRAPER_PLAN.md) — that plan made **extraction**
universal and self-improving. This one makes **target selection** universal and
self-improving. It sits *in front of* the existing pipeline and feeds it; nothing
below `scrapeUrls()` needs to change conceptually.

**Baseline:** commit `8ecb67c`. All 21 items of SCRAPER_PLAN are ✅. Tests green.

---

## The problem

Today the user must know that Daraz's flash sale lives at
`daraz.com.bd/wow/i/bd/LandingPage/flashsale`, that Chaldal's is `/deals`, that
Pickaboo's is `/campaign/...`. That knowledge is the scarce input — and it goes
stale every campaign season.

**After this plan:**

```
input:  "chaldal.com"
        ↓  discovery (bounded, cached, ~8–20 cheap HTTP fetches)
found:  /deals                          score 0.91  ← nav link "Deals", 78% strike-through
        /offers/weekly                  score 0.74  ← sitemap, lastmod 2d ago
        /flash-sale                     score 0.68  ← probe hit, countdown timer present
        /wholesale                      score —     ← rejected: token "wholesale" ≠ "sale"
        ↓  ALL verified URLs saved to the registry; top-K into scrapeUrls()
output: deals, comparisons, per-page confidence
        + a durable saved list that re-fetches itself from then on
```

The list is the point as much as the deals are. Discovery typically finds ~14
candidates and scrapes 3 — the other 11 verified URLs are stored, not discarded,
and tomorrow's run (or the scheduler, with no user present) starts from them.

---

## Guiding constraints

These extend, and never override, the constraints in SCRAPER_PLAN.

1. **No site-specific branches.** No `if (host === 'daraz')`. Ever. Site knowledge
   is permitted only when **learned at runtime and self-correcting** (§D6).
2. **Platform-specific ≠ site-specific.** A probe pack keyed off a *detected
   e-commerce platform* (Shopify, WooCommerce, Magento) is a general strategy —
   it applies to millions of unseen sites. This is the escape valve that keeps
   the system both general *and* sharp. Detection must be a fingerprint, never a
   hostname.
3. **Bounded, always.** Discovery is a **best-first search over one registrable
   domain with a hard fetch budget** — never a crawl. Every source has a cap,
   every tier has an early exit.
4. **Cheap tiers first, and never run an expensive tier that a cheap tier made
   unnecessary.** Probing 8 conventional paths is pointless if the nav already
   handed us three verified deal pages.
5. **Discovery output is untrusted remote input.** Every discovered URL is
   attacker-influenced. It re-enters the SSRF guard *and* a new same-site guard
   before anything fetches it (§D1). This is the single largest new attack
   surface in the project.
6. **A candidate is a hypothesis until verified.** Keyword match earns a fetch,
   not a scrape. Only measured **deal density** earns a full crawl (§D4).

---

## Status summary

| # | Item | Phase | Effort | Status |
|---|---|---|---|---|
| 1 | Discovery types + fixture harness | D0 | 4h | ☐ |
| 2 | Registrable-domain (eTLD+1) same-site guard | D1 | 4h | ☐ |
| 3 | URL canonicalization + dedupe | D1 | 3h | ☐ |
| 4 | Keyword lexicon (weighted, multilingual, seasonal) | D2 | 5h | ☐ |
| 5 | Candidate scoring function (pure) | D2 | 5h | ☐ |
| 6 | Source: link harvest (nav / hero / footer) | D3 | 1d | ☐ |
| 7 | Source: sitemap (index recursion, gz, caps) | D3 | 6h | ☐ |
| 8 | Platform fingerprint + probe packs | D3 | 6h | ☐ |
| 9 | Source: browser-assisted harvest (CSR homepages) | D3 | 5h | ☐ |
| 10 | Verification pass + deal-density metric | D4 | 1d | ☐ |
| 11 | Product-set fingerprint dedupe | D4 | 3h | ☐ |
| 12 | Frontier + budget orchestrator | D5 | 1d | ☐ |
| 13 | **Deal-URL registry — durable saved list** | D6 | 1d | ☐ |
| 14 | Registry lifecycle state machine + health stats | D6 | 6h | ☐ |
| 15 | Per-host discovery memo (short TTL) | D6 | 4h | ☐ |
| 16 | API / SSE / types wiring | D7 | 5h | ☐ |
| 17 | Registry API (CRUD, pin/exclude, export/import) | D7 | 5h | ☐ |
| 18 | Client: domain input + discovery panel | D8 | 1d | ☐ |
| 19 | Client: Saved Pages view | D8 | 5h | ☐ |
| 20 | Graceful degradation (no dedicated deal page) | D9 | 5h | ☐ |
| 21 | **Autonomous refresh scheduler (auto-fetch loop)** | D10 | 1d | ☐ |
| 22 | Adaptive per-page refresh cadence | D10 | 4h | ☐ |

Rough total: **~12 working days**. **D0–D4 (~5 days) is the whole idea working
end to end**; D5–D9 make it fast, legible and repeatable; **D6 + D10 are what
turn it from a search tool into a standing watchlist that fetches itself.**

---

## Architecture at a glance

```
POST /api/scrape { targets: ["chaldal.com", "https://x.com/sale"] }
  │
  ├─ target is a bare domain / site root?  ──no──►  straight into scrapeUrls()
  │                                                  (today's behaviour, unchanged)
  yes
  ▼
┌──────────────────────── discovery/index.ts ─────────────────────────┐
│  D6  REGISTRY lookup ──hit──► saved deal URLs ──► cheap re-verify ──┼──► scrape
│         │miss (or majority dead)                                    │
│         ▼                                                           │
│  D3  SOURCES (parallel where hosts allow, all budget-capped)        │
│      ├ robots.txt  → Sitemap: directives     [1 fetch, cached]      │
│      ├ homepage    → nav/hero/footer anchors [1 fetch, reused ×3]   │
│      ├ sitemaps    → keyword-matching paths  [≤4 fetches]           │
│      ├ platform    → probe pack              [≤8 fetches, TIER 3]   │
│      └ browser     → CSR shell fallback      [1 render, TIER 4]     │
│         │                                                           │
│         ▼                                                           │
│  D1/D2 canonicalize → same-site guard → score → rank → top-N        │
│         │                                                           │
│         ▼                                                           │
│  D4  VERIFY (≤6 cheap fetches): extract → quality × deal density    │
│         │                        → fingerprint dedupe               │
│         ▼                                                           │
│  D5  frontier: a verified *hub* may expand one level (decayed)      │
│         │                                                           │
│         ▼  UPSERT into the registry + write memo (D6)               │
└─────────┼───────────────────────────────────────────────────────────┘
          ▼
   top-K URLs ──► existing scrapeUrls() ladder (unchanged)

        ┌─────────────────────────────────────────────────┐
        │  .cache/deal-registry.json  ← the durable list   │
        │  every URL ever found, with health + due time    │
        └───────────────┬──────────────────┬──────────────┘
                        │                  │
        D10 scheduler ──┘                  └── D7 API / D8 UI
        (auto-fetch what's due, no user)       (list, pin, exclude, export)
```

**The reuse that makes this cheap:** verification is *the SSR rung you already
have*. `fetchHtml` → `extractWithDiagnostics` → `scoreExtraction`. No new
extraction code, and the HTML fetched during verification is handed to the
scraper so the winning page is never fetched twice.

---

## Phase D0 — Contracts and the test harness

> Same rule as SCRAPER_PLAN Phase 0: **nothing else starts before this.** Every
> heuristic below fails *silently* — you get the wrong page, not an exception.

### D0.1 Types

`server/src/types.ts`:

```ts
export type CandidateSource =
  | 'root'        // the domain itself — sometimes the homepage IS the sale page
  | 'nav'         // header / mega-menu anchor
  | 'hero'        // above-the-fold banner link
  | 'body'        // in-content anchor
  | 'footer'
  | 'sitemap'
  | 'probe'       // conventional path guess
  | 'platform'    // platform-specific known route (Shopify collections, …)
  | 'network'     // campaign endpoint seen during a browser render
  | 'expanded'    // found on a page that itself verified as a deal hub
  | 'memo';       // remembered from a previous run

export interface DealCandidate {
  url: string;            // canonical form (D1.2)
  source: CandidateSource;
  /** Human-readable justification — shown in the UI, invaluable in tests. */
  evidence: string[];     // ['anchor:"Flash Sale"', 'path:/flash-sale', 'lastmod:2d']
  priorScore: number;     // 0..1, pre-fetch (D2)
  verified?: VerificationResult;
  finalScore?: number;    // 0..1, blended (D4.3)
}

export interface VerificationResult {
  productCount: number;
  /** Fraction of products carrying an originalPrice or discountPercentage. */
  dealDensity: number;
  medianDiscountPct: number | null;
  quality: ExtractionQuality;     // reused from utils/quality
  hasCountdown: boolean;          // structural flash-sale tell
  renderType: RenderType;
  /** Hash of the top-N normalized titles — collapses duplicate listings. */
  productFingerprint: string;
  rejectedReason?: string;
}

export interface DiscoveryReport {
  domain: string;
  platform: string | null;
  candidatesFound: number;
  candidatesVerified: number;
  selected: DealCandidate[];      // what actually got scraped
  rejected: DealCandidate[];      // with reasons — this is the debugging surface
  fetchCount: number;
  durationMs: number;
  fromMemo: boolean;
  budgetExhausted: boolean;
}
```

Also extend `SitePhase`: `'discovering' | 'verifying'` alongside the existing four.

### D0.2 Fixtures — the same discipline that saved the extractor

Every discovery input is **a document**, so every source parser is pure and
network-free. Exploit that exactly as Phase 0 did.

```
server/test/fixtures/discovery/
  shopify-home.html          # nav with "Sale", collections/ links
  woocommerce-home.html      # ?on_sale=1 filter link
  bd-marketplace-home.html   # Bangla nav: "অফার", "ফ্ল্যাশ সেল"
  spa-shell-home.html        # 4 anchors total → must escalate to browser tier
  sitemap-index.xml
  sitemap-pages.xml          # mixed: /deals, /blog/best-deals-2024, /wholesale
  deal-page.html             # 40 cards, 85% strike-through → verifies
  category-page.html         # 40 cards, 4% strike-through → rejected
  blog-post.html             # the word "deals" 30× and zero products → rejected
  expected/*.json            # ranked candidate lists — the specification
```

| Function | Cases that must be locked down |
|---|---|
| `canonicalizeUrl` | strips `utm_*`/`fbclid`/`gclid`, sorts kept params, drops fragment, collapses `//`, normalizes trailing slash, keeps `?page=2` |
| `registrableDomain` | `pages.daraz.com.bd` → `daraz.com.bd` (multi-part suffix), `a.b.co.uk` → `b.co.uk`, `localhost` → null |
| `isSameSite` | subdomain allowed, `daraz.com` vs `daraz.com.bd` rejected, `evil-chaldal.com` rejected, `chaldal.com.attacker.io` rejected |
| `scoreCandidate` | `/wholesale` scores 0, `/flash-sale` high, `/blog/top-10-deals` stoplisted, anchor text beats path, Bangla tokens match |
| `parseSitemap` | index recursion, `.xml.gz`, `lastmod` parse, entity-escaped URLs, malformed XML tolerated |
| `verifyCandidate` | deal page passes, category page fails on density, blog fails on product count |
| `dedupeByFingerprint` | two URLs, same top-20 products → one survives, the higher-scored one |
| `registry` lifecycle | 2 misses → parked (not deleted); pinned survives every automatic rule; excluded is never re-added by discovery; upsert refreshes evidence without resetting health; `blocked` changes nothing |
| `nextCheckAt` cadence | high `changeRate` → floor (1 h); zero change → ceiling (7 d); jitter applied; parked entries ignore cadence and honour `revisitAfter` |
| `registry.due()` | never returns two entries of one domain in a tick; respects the per-tick cap; ordering is (priority, nextCheckAt) |

**Rule, inherited:** a snapshot change is reviewed as a diff, never blind-updated.
Every discovery bug gets a fixture *first*.

**Acceptance:** `npm test` green; deliberately adding `wholesale` to the lexicon
turns a test **red**.

---

## Phase D1 — Guards (security before capability)

### D1.1 The same-site guard — **required before any discovered URL is fetched**

`assertPublicUrl` stops private-network targets. It does **not** stop the new
problem: discovery reads links out of remote HTML and then fetches them. A
compromised or hostile page can point anywhere on the public internet — turning
this service into an open proxy / request amplifier that a victim site sees as
traffic from *your* IP.

Constraint: **a discovered URL must live on the same registrable domain (eTLD+1)
as the user's input.** Subdomains yes (`pages.daraz.com.bd`), anything else no.

`server/src/utils/sameSite.ts`:

```ts
/**
 * eTLD+1 without shipping the full Public Suffix List. A compact table of
 * multi-part suffixes covers the cases a shopping crawler actually meets;
 * anything unlisted falls back to last-two-labels, which is correct for
 * the overwhelming majority of gTLDs.
 *
 * Trade-off, stated deliberately: this is a REJECTION filter. Getting it
 * slightly wrong loses a candidate; it never grants access it shouldn't,
 * because the fallback (last two labels) is the STRICTER answer.
 */
const MULTI_PART_SUFFIXES = new Set([
  'com.bd','net.bd','org.bd','co.uk','org.uk','ac.uk','com.au','co.in',
  'com.br','co.jp','com.sg','com.my','com.pk','co.nz','com.tr','co.za',
  // …extend from data, not from guesses
]);

export function registrableDomain(host: string): string | null { /* … */ }

export function isSameSite(candidate: string, root: string): boolean {
  const a = registrableDomain(new URL(candidate).hostname);
  const b = registrableDomain(new URL(root).hostname);
  return a !== null && a === b;
}
```

Every candidate passes, in order: `canonicalizeUrl` → `isSameSite` →
`assertPublicUrl` → robots check → rate limiter → fetch. **No shortcuts, no
exceptions, including for URLs read out of a sitemap** (sitemaps are remote
content too).

Config: `DISCOVERY_ALLOW_CROSS_SITE=true` exists as a documented, loudly-logged
escape hatch for the genuine case of a merchant hosting campaigns on a separate
brand domain. Default **off**.

### D1.2 Canonicalization

The candidate space explodes without this — faceted nav alone generates
thousands of `?color=red&size=m&on_sale=1` permutations of one page.

```ts
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|msclkid|mc_|ref|referrer|source|_ga)/i;

/** Keep only params that plausibly change the PRODUCT SET. */
const MEANINGFUL_PARAMS = /^(page|p|pageNo|pageNumber|sort|order|q|query|search|filter|on_sale|category|cat|collection|tag|type|brand|discount|min_price|max_price)$/i;

export function canonicalizeUrl(raw: string, base: string): string | null {
  // absolute-ize; http(s) only; drop fragment; drop tracking params;
  // drop params not in MEANINGFUL_PARAMS; sort remaining; lowercase host;
  // strip default port; collapse duplicate slashes; normalize trailing slash;
  // cap path depth and total length (a 4KB URL is never a deal page)
}
```

Dedupe on the canonical form. Track the *best* evidence across duplicates rather
than keeping the first — a path also found in the nav is stronger than the same
path found only in a sitemap.

---

## Phase D2 — The lexicon and the scorer

Both pure, both network-free, both fixture-tested. **This is the brain of
discovery, and it is ~200 lines of testable code with zero I/O.**

### D2.1 Tokenization — where precision comes from

Do **not** substring-match. Substring matching is why naive versions of this
system scrape `/wholesale`, `/salem-store-locator`, and `/sales-tax-policy`.

```ts
/** Split on non-alphanumerics AND camelCase, keeping Bangla as word chars. */
export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9ঀ-৿]+/)
    .filter(Boolean);
}
```

`tokenize('/wholesale-buyers')` → `['wholesale','buyers']`. The token `sale`
never appears, so it never matches. **The negative list exists only for tokens
that are genuinely their own word** (`wholesale` as a nav item, `resale`,
`salesman`). This is the difference between ~60% and ~95% path precision.

Match unigrams *and* bigrams — `flash sale`, `price drop`, `special offer` carry
far more signal than either half alone.

### D2.2 The lexicon

`server/src/discovery/lexicon.ts` — data, not logic. Loadable/extendable from
`DISCOVERY_LEXICON_PATH` (JSON) so a user can add a language without a code change.

| Tier | Weight | Tokens / bigrams |
|---|---|---|
| **A — explicit deal intent** | 1.00 | `deal`, `deals`, `discount`, `discounts`, `offer`, `offers`, `sale`, `sales`, `clearance`, `outlet`, `promo`, `promotion`, `promotions`, `flash sale`, `flashsale`, `hot deals`, `daily deals`, `deal of the day`, `price drop`, `markdown`, `liquidation`, `blowout`, `doorbuster`, `bargain`, `on sale`, `super saver` |
| **B — campaign / seasonal** | 0.90 (+0.10 in season) | `black friday`, `cyber monday`, `singles day`, `11.11`, `12.12`, `boxing day`, `summer sale`, `winter sale`, `eid`, `eid offer`, `ramadan`, `boishakh`, `pohela boishakh`, `puja`, `christmas`, `new year sale`, `anniversary sale`, `mega sale`, `back to school`, `campaign` |
| **C — weak / supporting** | 0.45 | `save`, `savings`, `special`, `budget`, `combo`, `bundle`, `lowest price`, `best price`, `under` |
| **BN — Bangla** | 1.00 / 0.90 | `ছাড়`, `অফার`, `ডিসকাউন্ট`, `সেল`, `ফ্ল্যাশ সেল`, `বিশেষ ছাড়`, `মূল্যছাড়`, `ক্যাম্পেইন` |
| **NEG — explicit rejects** | −1.00 | `wholesale`, `resale`, `salesman`, `salesforce`, `salem`, `saletax` |
| **STOP — path segments** | reject | `blog`, `news`, `article`, `press`, `help`, `faq`, `support`, `terms`, `privacy`, `policy`, `policies`, `careers`, `jobs`, `about`, `contact`, `login`, `signin`, `register`, `cart`, `checkout`, `account`, `wishlist`, `compare`, `return`, `refund`, `shipping`, `track`, `review`, `reviews` |

Misspellings matter — merchants ship `/clearence`, `/discout`, `/speical-offer`.
Handle with a **bounded edit-distance-1 match against Tier A only** (never
against short tokens: `sale`/`sales`/`sold`/`sole` are one edit apart). Cheap and
it earns its keep on real sites.

**Seasonal awareness** — the boost is a data lookup, not a branch:

```ts
// A "Black Friday" link in November is a live campaign.
// The same link in March is a stale archive page.
const SEASON: Record<string, number[]> = {   // token → months (1-12)
  'black friday': [11], 'cyber monday': [11, 12], 'christmas': [11, 12],
  'summer sale': [4, 5, 6, 7], 'eid': [3, 4, 5, 6], 'boishakh': [4],
  '11.11': [11], '12.12': [12], 'back to school': [7, 8, 9],
};
```

Out-of-season Tier-B tokens are **not** rejected — they are damped to 0.45.
A merchant who never took the banner down still has a page full of markdowns.

### D2.3 The prior score

```ts
export function scoreCandidate(c: RawCandidate, ctx: ScoreContext): {
  score: number; evidence: string[];
} {
  // 1. keyword: max over (anchorText × 1.0, pathTokens × 0.85, title × 0.7)
  //    — anchor text is the merchant's OWN label for the page. Trust it most.
  // 2. source prior:
  //      nav 1.00 · hero 0.90 · platform 0.80 · probe 0.70
  //      body 0.60 · sitemap 0.55 · footer 0.50 · expanded 0.45 · search 0.30
  // 3. bonuses:  +0.10 sitemap lastmod < 14d
  //              +0.10 link repeated in both nav and footer (a real section)
  //              +0.05 path depth 1
  // 4. penalties: −0.30 depth > 3            (a deal HUB is never deep)
  //               −0.40 looks like a product detail page
  //                     (/p/, /product/, /dp/, trailing -12345, .html + SKU-ish)
  //               −0.25 has ≥3 query params  (faceted-nav permutation)
  //               −1.00 STOP segment · −1.00 NEG token   → hard reject
  //
  // score = clamp01(0.60·keyword + 0.40·sourcePrior + bonuses − penalties)
}
```

Every term appends to `evidence[]`. When a user asks *"why did you scrape
`/campaign/eid-2026`?"*, the answer is in the response payload — no log
archaeology. This is also what makes the fixture snapshots readable as a
specification.

**Acceptance for D2:** on the fixture set, precision@5 ≥ 0.8 with **zero**
network access in the tests.

---

## Phase D3 — Sources, cheapest first

Tiered with early exit. `enough()` = *"≥ `discovery.minCandidates` (default 4)
candidates scoring ≥ 0.55"*. **A tier that isn't needed never runs.**

### Tier 0 — free (already fetched, or one fetch)

- **`robots.txt`** — extend `utils/robots.ts` to also return `Sitemap:`
  directives. It is already fetched and cached per origin; this is *zero* extra
  network cost and it is the authoritative sitemap location.
- **The root URL itself** is always candidate #1 (`source: 'root'`). On
  marketplaces the homepage *is* the flash-sale page. It costs nothing to
  verify a page that's already downloaded.

### Tier 1 — homepage link harvest (1 fetch, reused four ways)

One `fetchHtml` of the root serves platform fingerprinting, link harvest,
verification of the root itself, and CSR detection. Do not fetch it twice.

```ts
export function harvestLinks(html: string, baseUrl: string): RawCandidate[] {
  // Region-aware, because WHERE a link sits is strong evidence:
  //   header, nav, [role=navigation], [class*=menu|nav]   → 'nav'
  //   first ~2 screens of markup / [class*=banner|hero|slider|carousel] → 'hero'
  //   footer, [class*=footer]                             → 'footer'
  //   everything else                                     → 'body'
  //
  // Per anchor collect: href, innerText, title/aria-label, img[alt]
  // (banner links are IMAGES — alt text is often the only label, and it is
  //  routinely the campaign name: alt="Eid Flash Sale up to 70% off").
  // Cap at 800 anchors; dedupe by canonical URL, keeping the best region.
}
```

The `img[alt]` case matters more than it sounds: on a large fraction of
storefronts the highest-value link on the page is an image banner with no text.

### Tier 2 — sitemaps (≤4 fetches, hard-capped)

Sitemaps are the highest-recall source and the easiest way to blow the budget —
a product sitemap index can be 50 MB across 200 files.

```
Rules, all enforced:
  · Sources: robots.txt Sitemap: lines, then /sitemap.xml, /sitemap_index.xml
  · Support .gz (gunzip stream)
  · Follow a sitemap INDEX only into children whose OWN URL scores on the
    lexicon (sitemap-pages.xml, sitemap-campaigns.xml) or is unlabelled;
    never into sitemap-products-*.xml
  · Max 4 sitemap documents, 5 MB each, 30s total, streaming parse
  · Stop early at 200 keyword-matching URLs
  · Score <loc> paths with the same scorer; keep <lastmod> for the freshness bonus
```

### Tier 3 — platform fingerprint + probe packs (≤8 fetches)

**Only when Tiers 0–2 didn't reach `enough()`.**

Fingerprint the homepage HTML generically — `<meta name="generator">`,
`cdn.shopify.com`, `/wp-content/plugins/woocommerce`, `Mage.Cookies`,
`bigcommerce.com/s-`, `/_next/`, `wixstatic.com`, `squarespace`, `opencart`,
`prestashop`, `magento`. Platform → probe pack:

| Platform | Probe paths (in order) |
|---|---|
| Shopify | `/collections/sale`, `/collections/all?filter.v.price.gte=0&sort_by=best-selling`, `/collections/clearance`, `/collections/deals` |
| WooCommerce | `/shop/?on_sale=1`, `/product-category/sale/`, `/sale/`, `/offers/` |
| Magento | `/sale.html`, `/deals.html`, `/promotions` |
| BigCommerce | `/sale/`, `/categories/sale` |
| *unknown* | `/deals`, `/offers`, `/sale`, `/discount`, `/promotions`, `/clearance`, `/flash-sale`, `/campaign` |

Probe discipline:
- Skip any path already discovered by Tiers 0–2 (the common case — probes are a
  fallback, not a default).
- `GET` (not `HEAD` — a large minority of storefronts 405 or lie on HEAD), with
  a small `maxContentLength`; a 404/redirect-to-home/soft-404 is a reject.
- **Soft-404 detection:** a probe whose HTML is ~identical to the homepage (same
  title + product fingerprint) is a reject, not a hit. Many platforms serve the
  homepage for unknown paths.
- Record misses in the memo's `negativePaths` (§D6) so the next run doesn't
  re-probe them.

### Tier 4 — browser-assisted harvest (1 render, last resort)

**Only when the homepage yielded < 15 usable anchors** — an SPA shell.

Reuse the existing shared browser and its network interception from
`csrScraper`. Two payoffs beyond the anchors:

1. Rendered nav/mega-menu links that never existed in the raw HTML.
2. **Campaign API endpoints seen on the wire** — `/api/campaigns`,
   `/api/homepage/blocks`. A JSON payload naming the site's live campaigns is
   strictly better than any keyword guess, and it feeds `source: 'network'` +
   the memo's `apiEndpoint`, exactly as SCRAPER_PLAN §4.2 already does for
   product APIs.

**Acceptance for D3:** each tier demonstrably contributes candidates on its
target fixture; the tier ladder short-circuits (assert `fetchCount` on a fixture
where Tier 1 already succeeded).

---

## Phase D4 — Verification: from hypothesis to evidence

A keyword match earns **one cheap fetch**, never a full crawl. Verification is
where confidence is actually created.

### D4.1 The cheap pass

Reuse the SSR rung wholesale — no new extraction code:

```ts
async function verifyCandidate(c: DealCandidate): Promise<VerificationResult> {
  const html = await fetchHtml(c.url, signal);          // rate-limited, guarded
  if (detectBlock(html)) return { rejectedReason: 'blocked', … };
  const { products, strategy } = extractWithDiagnostics(html, c.url, site);
  //  ↑ single page only: NO pagination, NO load-more, NO browser.
  //    Cap at 60 products — enough to measure, cheap to get.
  return {
    productCount: products.length,
    dealDensity: pct(products, p => p.originalPrice !== null || p.discountPercentage !== null),
    medianDiscountPct: median(products.map(p => p.discountPercentage).filter(Boolean)),
    quality: scoreExtraction(products, c.url, html),
    hasCountdown: COUNTDOWN_RE.test(html),
    productFingerprint: fingerprint(products),
    renderType: /* reuse detectRenderingType's scoring on the html we already have */,
  };
}
```

**Countdown detection** is a genuinely strong, entirely structural flash-sale
tell — `[class*=countdown]`, `[data-countdown]`, `[class*=timer]`, and
`ends in|hurry|limited time|শেষ হবে`. Cheap, general, high signal.

**CSR caveat, handled:** a candidate whose cheap pass yields 0 products but whose
HTML detects as CSR is **not rejected** — it is marked `unverified-csr` and kept
at its prior score. It gets scraped if it lands in the top-K; the full ladder
below it already knows how to render. Rejecting it here would be exactly the
"a partial scrape looks like a complete one" mistake SCRAPER_PLAN Phase 3 fixed.

### D4.2 Deal density, and the trap in it

`dealDensity` is the single most discriminating signal available: a sale page
runs 60–95%, a category page 2–10%.

**But do not hard-gate on it.** Plenty of legitimate flash-sale pages render only
the final price with no strike-through — density 0, and they are still exactly
what the user asked for. So:

```
accept   if productCount ≥ 8 AND quality.score ≥ escalateBelow
         AND (dealDensity ≥ 0.30 OR hasCountdown OR priorScore ≥ 0.80)
reject   if productCount < 3                → 'not-a-listing'  (blog, landing page)
reject   if dealDensity < 0.05 AND priorScore < 0.75  → 'no-discounts'
demote   otherwise (kept, ranked below accepted candidates)
```

Numbers live in `config.discovery.*`. They are the tuning surface, so they must
be env knobs from day one, not constants.

### D4.3 Final ranking

```ts
finalScore = 0.35 · priorScore
           + 0.30 · min(1, productCount / 40)
           + 0.20 · dealDensity
           + 0.15 · quality.score
           + 0.05 · (hasCountdown ? 1 : 0)
```

### D4.4 Fingerprint dedupe — the biggest single efficiency win

`/deals`, `/collections/sale` and `/offers?sort=popular` routinely serve the
**same product set**. Scraping all three triples the cost for zero new products,
and inflates the comparison view with self-matches.

```ts
// Jaccard over the top-20 normalized titles; ≥0.80 overlap ⇒ same listing.
// Keep the higher finalScore; record the loser as 'duplicate-of: <url>'.
```

Run this *after* verification (the cheap pass already gave us the products) and
*before* the expensive full scrape. It typically removes 30–50% of the scrape
work on real storefronts.

---

## Phase D5 — Frontier, budgets, orchestration

### D5.1 Budgets — non-negotiable, all enforced centrally

```ts
discovery: {
  maxFetches:        num(process.env.DISCOVERY_MAX_FETCHES, 20),
  maxDurationMs:     num(process.env.DISCOVERY_MAX_MS, 45_000),
  maxCandidates:     num(process.env.DISCOVERY_MAX_CANDIDATES, 120),
  maxVerify:         num(process.env.DISCOVERY_MAX_VERIFY, 6),
  maxScrape:         num(process.env.DISCOVERY_MAX_SCRAPE, 3),  // top-K → full ladder
  minCandidates:     num(process.env.DISCOVERY_MIN_CANDIDATES, 4),
  maxExpandDepth:    num(process.env.DISCOVERY_MAX_DEPTH, 1),
  memoTtlHours:      num(process.env.DISCOVERY_MEMO_TTL_HOURS, 12),

  // registry (D6) + scheduler (D10)
  registryMax:       num(process.env.DISCOVERY_REGISTRY_MAX, 5_000),
  staleAfterHours:   num(process.env.DISCOVERY_STALE_AFTER_HOURS, 24),
  autoRefresh:       process.env.AUTO_REFRESH === 'true',        // OFF by default
  refreshTickMs:     num(process.env.REFRESH_TICK_MS, 300_000),  // 5 min
  refreshPerTick:    num(process.env.REFRESH_PER_TICK, 5),
  refreshMinHours:   num(process.env.REFRESH_MIN_HOURS, 1),
  refreshMaxHours:   num(process.env.REFRESH_MAX_HOURS, 168),    // 7 days
}
```

A single `DiscoveryBudget` object is threaded through every source and checked
before *every* fetch. Exhaustion is a normal, reported outcome
(`budgetExhausted: true`), never an error — you return the best candidates found
so far. Cancellation (`AbortSignal`) threads through identically to the existing
pipeline.

### D5.2 The frontier

A priority queue over `DealCandidate`, popped by `priorScore`:

```
1. seed with root + all Tier 0–2 candidates
2. while (budget allows && verified < maxVerify):
     pop highest-scoring unverified candidate
     verify it (D4)
     if it verified as a HUB — many outbound links scoring ≥0.6, few products —
       harvest its links, push at depth+1 with priority × 0.7
     if depth would exceed maxExpandDepth, don't expand
3. dedupe by fingerprint, rank, take top maxScrape
```

The hub-expansion case is real and worth the code: `/offers` is frequently a
directory of campaigns (`/offers/eid`, `/offers/electronics-week`) rather than a
listing itself. One level of decayed expansion catches it; two would be a crawl.

### D5.3 Per-host cost, stated honestly

Discovery is **serialized per host** by the existing `hostRateLimiter`
(`perHostConcurrency: 1`, 500–1500 ms jitter). That is correct for not getting
banned, and it means 20 fetches ≈ 20–30 s wall-clock. Two consequences to design
around rather than fight:

- **The budget is small on purpose.** Every tier's early exit is a latency
  feature, not just a politeness one.
- **Multiple domains parallelize freely** — different hosts, different buckets.
  A 5-domain request is not 5× the wall-clock.

A separate `DISCOVERY_HOST_DELAY_MS` (default 300, below the scrape delay) is
justified: discovery fetches are single cheap GETs, not sustained crawls.

---

## Phase D6 — Persistence: the registry and the memo

Two stores, deliberately separate, because they answer different questions and
have wildly different lifetimes.

| | **Deal-URL registry** (D6.1) | **Discovery memo** (D6.4) |
|---|---|---|
| Answers | *"Which pages sell discounted things?"* | *"How do I search this site?"* |
| Keyed by | URL | registrable domain |
| Lifetime | **durable — the product of the system** | hours; a disposable cache |
| Losing it costs | every campaign ever found | one slow run |
| Consumed by | the scheduler, the API, the UI, the frontier | discovery only |

Collapsing them was tempting and would have been wrong: a cache you may delete
at any time is a bad home for the list a user has curated by hand.

---

### D6.1 The registry — the saved list

`server/src/discovery/registry.ts`. **Every URL discovery has ever verified,
kept, with enough health data for the scheduler to decide when to fetch it
again.** This is the artifact the rest of this phase exists to serve.

```ts
export type RegistryStatus =
  | 'candidate'  // found and scored, not yet verified
  | 'active'     // verified, has deals — auto-fetch this
  | 'stale'      // not verified within staleAfterHours — re-verify before use
  | 'parked'     // verified empty/dead. NOT deleted — see the seasonal note
  | 'excluded'   // user said no. never auto-fetch, never re-add
  | 'pinned';    // user said yes. never demoted, never evicted, never scored

export interface DealPageRecord {
  id: string;                 // sha1(canonical url) — stable primary key
  url: string;                // canonical form (D1.2)
  domain: string;             // registrable domain (D1.1)
  site: string;               // display name
  status: RegistryStatus;
  source: CandidateSource;
  evidence: string[];         // why we ever believed in this URL
  /** The merchant's OWN label — "Eid Flash Sale", "Clearance". The single
   *  most human-legible field in the whole system; show it everywhere. */
  label: string | null;

  firstSeenAt: number;
  lastSeenAt: number;         // last time discovery re-found it
  lastVerifiedAt: number | null;
  lastScrapedAt: number | null;
  lastChangedAt: number | null;   // last time the product set actually changed
  /** The scheduler's sort key. THE index this whole store exists for. */
  nextCheckAt: number;
  /** Parked seasonal pages wake up here (e.g. next November for Black Friday). */
  revisitAfter: number | null;

  // Rolling health — EWMA, never last-value. One bad fetch (a blip, a deploy,
  // a momentary WAF) must not be able to kill an entry that has worked 50×.
  finalScore: number;
  dealDensity: number;
  avgProductCount: number;
  medianDiscountPct: number | null;
  productFingerprint: string | null;
  checkCount: number;
  successCount: number;
  consecutiveMisses: number;
  /** Fraction of checks where the fingerprint changed → drives cadence (D10.2). */
  changeRate: number;
  /** Months (1-12) this page has ever been active — learned seasonality. */
  seasonHint: number[];

  userPinned: boolean;
  notes: string | null;
}
```

### D6.2 Lifecycle — where the self-correction lives

```
                 discovery finds it
                        ▼
                   [candidate]
                        │ verifies (D4 accept)
                        ▼
   ┌───────────────► [active] ◄──────────── re-verify OK
   │                    │
   │  no check within    │ 2 consecutive misses
   │  staleAfterHours    │ (404 / 0 products / no discounts)
   │                    ▼
   │                [parked]  ── revisitAfter reached ──► [candidate]
   │                    ▲
   └── [stale] ─────────┘  (re-verify fails)
          │
          └── re-verify OK ──► [active]

   user action, at any point:  → [pinned]  (immune to every rule above)
                               → [excluded] (terminal; blocks re-discovery)
```

**Parked, not deleted — the point worth arguing for.** A Black Friday page 404s
for eleven months a year. Deleting it means rediscovering it from scratch every
November *and* losing its price history. Parking costs one JSON row and makes
the system get *better* year over year: `seasonHint` records the months a page
was ever live, and `revisitAfter` is set to the next such month rather than to
"tomorrow". Seasonal knowledge is exactly the kind of thing that should be
learned at runtime rather than typed into a lexicon.

Invariants, mirroring `strategyCache`:

```
1. status 'blocked' NEVER changes a record. A WAF says nothing about whether
   a page sells discounted goods.       [same rule as strategyCache §4.1]
2. 'pinned' and 'excluded' are USER facts. No automatic rule ever overwrites
   them — not eviction, not TTL, not consecutiveMisses.
3. Health stats are EWMA (α ≈ 0.3): one bad check moves the number, never
   decides the outcome.
4. Re-discovery UPSERTS by id — it refreshes lastSeenAt and evidence,
   and never resets health or resurrects an 'excluded' entry.
```

### D6.3 Storage — durable data deserves better than the cache treatment

`server/.cache/deal-registry.json`, but with three differences from the existing
caches, all justified by "losing this loses user work, not just time":

- **Atomic writes** — write `.tmp`, `fsync`, `rename`. A crash mid-write must not
  truncate the list.
- **Keep one `.bak`** of the last good file. Corrupt primary → load the backup
  and log loudly, instead of the caches' silent start-fresh.
- **Export / import** as JSON *and* CSV (`url,domain,label,status,dealDensity,
  lastVerifiedAt`). The list is the user's asset; it must be portable out of the
  tool. This is also the entire backup story at this scale.

Cap at `DISCOVERY_REGISTRY_MAX` (default 5000) entries. Eviction order:
`parked` past `revisitAfter` by > 1 year → oldest `lastSeenAt` among non-active.
`pinned` and `active` are never evicted; hitting the cap with 5000 active
entries is a warning, not a silent deletion.

Migration path: the access pattern (single-key lookup, sort by `nextCheckAt`,
filter by `domain`/`status`) is a SQLite table with two indexes the moment JSON
stops being comfortable — but at 5k rows and one writer, JSON is genuinely fine
and keeps the dependency count at zero. Keep every access behind the
`registry.ts` module boundary so the swap stays a one-file change.

### D6.4 The memo — what stays ephemeral

Everything that is a fact about *searching the site*, not about a page:

```ts
interface DiscoveryMemo {
  domain: string;
  platform: string | null;
  sitemapUrls: string[];              // skip robots+sitemap discovery next time
  negativePaths: string[];            // probed, 404'd — never probe again
  campaignApiEndpoint: string | null; // from Tier 4
  lastDiscoveryAt: number;
}
```

`server/.cache/discovery-memo.json`, debounced write, corrupt-file-starts-fresh —
the throwaway treatment is correct here, because everything in it is
re-derivable in one run.

### D6.5 How a run uses both

```
1. Registry: load 'active' + 'pinned' + due 'stale' records for the domain.
2. Any that verify (cheap pass, D4.1) → scrape them. Update health.
3. Fewer than half survive, OR zero active records → run FULL discovery.
   Registry records seed the frontier at priorScore 0.7; the memo skips
   Tiers 0–2 work already done.
4. Every verified candidate → UPSERT into the registry, including the ones
   that lost the top-K cut. They cost nothing to store and they are exactly
   what tomorrow's scheduler run should try.
5. 'excluded' URLs are filtered out of the frontier before scoring — a user's
   "no" must not cost a fetch to re-learn.
```

Note step 4: **the registry saves more than it scrapes.** Discovery routinely
finds 14 candidates and scrapes 3. Throwing away the other 11 verified URLs
would be the single most wasteful thing this system could do.

**Payoff:** a warm run does 1–3 cheap verification fetches instead of 20, and
starts the real scrape in ~2 s instead of ~25 s — and the list it built keeps
working without a user present (D10).

---

## Phase D7 — API, SSE and types

### D7.1 Request shape

Backwards compatible — `urls` keeps working exactly as today.

```jsonc
POST /api/scrape
{
  "targets": ["chaldal.com", "https://othoba.com/flash-sale"],
  "discovery": {                     // all optional
    "enabled": "auto",               // 'auto' | 'always' | 'never'
    "maxScrape": 3,
    "minDiscountPercent": 10,        // post-filter the products
    "include": ["/campaign/*"],      // user pins (skip scoring, still verified)
    "exclude": ["/blog/*"]
  }
}
```

`"auto"` = run discovery when the target is a bare domain or a site root; skip it
when the user gave a specific deep path. That is the correct default: an explicit
path is an explicit instruction.

**`targets: []` (or omitted) = "scrape my saved list"** — every `active` and
`pinned` registry record, no discovery, no domain typed. This is the payoff of
D6 expressed as one API case, and it is what the scheduler in D10 calls.

`GET /api/discover?domain=…` — discovery only, no scrape. Invaluable for tuning
the lexicon against real sites, and it makes the ranked list inspectable without
paying for a crawl.

### D7.3 Registry endpoints — the saved list as a first-class resource

```
GET    /api/registry?domain=&status=&sort=nextCheckAt&limit=
                                  → paginated DealPageRecord[]
POST   /api/registry              → add a URL by hand (verified before it's
                                    accepted; a bad URL is a 400, not a bad row)
PATCH  /api/registry/:id          → { status: 'pinned' | 'excluded' | 'active',
                                      label?, notes?, nextCheckAt? }
DELETE /api/registry/:id          → hard delete (distinct from 'excluded',
                                    which is a remembered "no")
POST   /api/registry/:id/refresh  → verify + scrape this one page now
POST   /api/registry/refresh      → run the due set now (manual scheduler tick)
GET    /api/registry/export?format=json|csv
POST   /api/registry/import       → merge; never clobbers pinned/excluded
```

Two deliberate choices: **`excluded` is not `DELETE`** (a delete gets
rediscovered next run; an exclusion is remembered), and **manual adds go through
verification** so the registry never accumulates rows nothing has ever confirmed.

### D7.2 SSE events

New phases `discovering` / `verifying` on the existing `site-status` stream, plus
one `discovery` event per domain carrying the full `DiscoveryReport`:

```
🔎 chaldal.com — scanning nav, sitemap…
🔗 Found 14 candidates (nav 6, sitemap 7, probe 1)
🧪 Verifying /deals … 42 products, 78% discounted ✅ 0.89
🧪 Verifying /wholesale-offers … 12 products, 3% discounted ❌ no-discounts
🗑️ /collections/sale duplicates /deals (94% same products)
🎯 Scraping top 2 of 14
```

The rejects being visible is the point. Silent selection is unauditable, and the
rejection list is what a user needs to tell you the lexicon is wrong.

### D7.4 Report plumbing

`ScrapeResult` gains `discovery?: DiscoveryReport[]`. Each `SiteReport` gains
`discoveredFrom?: string` (the domain that produced it) and `candidateScore?`.

---

## Phase D8 — Client

- Input accepts bare domains; placeholder becomes `chaldal.com` — the whole
  premise of this plan is that a domain is enough.
- A **Discovery panel** per domain: candidates with score, source chip, evidence
  and verification verdict. Rejected candidates collapsed behind
  *"14 rejected — why?"*.
- **Pin / exclude** a candidate → the client writes it into
  `discovery.include` / `.exclude` for the next run. Human correction is the
  cheapest possible accuracy improvement, and it is the honest answer to the
  cases the lexicon will never get right.
- Discovery is a phase in `StatusFeed` with its own spinner — a 25 s silent gap
  before the first product reads as a hang.
- Reuse the existing confidence dot for `dealDensity`.

### D8.2 The Saved Pages view

The registry made visible — without this, D6 is a file nobody can see.

- Table of `DealPageRecord`s: **label** ("Eid Flash Sale"), domain, status chip,
  deal density, avg product count, last checked, next check. Group by domain,
  filter by status, sort by anything.
- Row actions: **Pin**, **Exclude**, **Refresh now**, **Delete**, edit label/notes.
- **"Scrape my list"** — one button, no typing: hits `POST /api/scrape` with
  `targets: []`. For a user with a curated watchlist this becomes the primary
  entry point to the whole app, ahead of the search box.
- **Add URL by hand** — verified inline, with the verdict shown before it's saved.
- Export / import buttons wired to the D7.3 endpoints.
- Parked seasonal rows shown greyed with *"waking Nov 2026"* rather than hidden —
  a dormant Black Friday page is information, not clutter.

---

## Phase D9 — Graceful degradation

Some storefronts have **no dedicated deal page at all**. Discounts are scattered
across normal category listings. Returning "0 deal pages found" is a correct but
useless answer.

Fallback ladder, when nothing clears the accept bar:

1. **Harvest the top category listings** from the nav (they score ~0 on the
   lexicon but they *are* product listings), verify up to 3, and keep any with
   `dealDensity ≥ 0.15`.
2. **Post-filter the products**: return only those with
   `originalPrice !== null || discountPercentage >= minDiscountPercent`.
3. **Report the degradation explicitly** — `DiscoveryReport.selected` carries
   `source: 'body'` with evidence `['fallback:category-listing']`, and the UI
   says *"No dedicated sale page found — filtered discounted items from 3
   category pages."*

Being clear about *how* an answer was obtained is worth more than the answer
looking clean.

---

## Phase D10 — Autonomous refresh: fetching the list without a user

The registry is a list of URLs known to sell discounted things. D10 is the loop
that keeps it true, and keeps the deals current, with nobody watching.

**Off by default** (`AUTO_REFRESH=true` to enable). A background process that
fetches other people's sites unattended is exactly the kind of thing that must
be opted into consciously, not inherited by anyone who runs `npm start`.

### D10.1 The loop

`server/src/discovery/scheduler.ts` — deliberately dull:

```ts
// One timer, refreshTickMs (5 min). No queue library, no cron parser.
async function tick() {
  if (inFlight) return;                        // never overlap ticks
  const due = registry.due(Date.now(), config.discovery.refreshPerTick);
  //  ↑ status active|stale|pinned, nextCheckAt <= now,
  //    sorted by (priority desc, nextCheckAt asc), max 1 per domain per tick
  for (const rec of due) {
    if (budgetExceeded() || paused) break;
    const result = await verifyAndScrape(rec);  // the SAME path a user request
                                                // takes — one code path, always
    registry.recordCheck(rec.id, result);       // health + nextCheckAt (D10.2)
    broadcast('registry-update', rec.id);       // any open SSE client sees it
  }
}
```

Non-negotiables, each one a way this goes wrong if skipped:

| Rule | Why |
|---|---|
| Never overlap ticks | A slow site must not stack 12 concurrent scrapes of itself |
| Max 1 entry per domain per tick | The whole point of `perHostConcurrency: 1`, at the scheduler layer |
| Reuses `hostRateLimiter` + robots + SSRF | The scheduler gets **no** privileges a request doesn't have |
| Hard cap on browser rungs per hour | An unattended loop launching Chromium is how you find out your box has 8 GB |
| `blocked` → back off, never demote | Registry invariant #1, and blocks cluster in time |
| Pause on N consecutive failures across *different* domains | That pattern means the network is down, not that the sites are — stop hammering |
| Never runs in the request path | A user request must never wait behind scheduled work |
| Full stop on SIGTERM, mid-tick | The current entry finishes or aborts; no half-written registry |

### D10.2 Adaptive cadence — where the efficiency is

A fixed interval is wrong in both directions: hourly on a static outlet page is
waste, daily on a flash sale means you always miss it. Let the page's own
measured behaviour decide.

```ts
// changeRate = EWMA of "did the product fingerprint change since last check?"
// dealDensity = how deal-dense the page is (a hot page deserves attention)
const interval = clamp(
  BASE_HOURS / (0.5 + rec.changeRate + rec.dealDensity),
  config.discovery.refreshMinHours,   // 1h  — floor, politeness AND sanity
  config.discovery.refreshMaxHours,   // 7d  — ceiling, so nothing is forgotten
);
rec.nextCheckAt = Date.now() + jitter(interval);   // ±15% — never a thundering herd
```

Consequences that fall out for free:
- A churning flash-sale page converges to ~1–2 h.
- A never-changing clearance page decays toward 7 d.
- A `parked` seasonal page ignores all of this and waits for `revisitAfter`.
- **Jitter matters:** without it, 200 records discovered in one session all come
  due in the same tick forever.

### D10.3 What a refresh actually does

Cheap-verify first, escalate only when it pays:

```
1. verify (1 fetch)  → dead / no discounts?  → miss++, maybe park. STOP.
2. fingerprint unchanged since last check?    → update changeRate, no scrape,
                                                 no products fetched. STOP.
   ↑ THE optimization: most refreshes end here, at one cheap GET.
3. changed → full scrape via the existing ladder → store products, bump
   lastChangedAt, recompute cadence.
```

Step 2 is what makes a 200-page watchlist affordable: a check costs one HTTP GET
and a hash comparison unless something actually changed.

### D10.4 Beyond scope, but this is the door

Once a durable list refreshes itself on a cadence, **price history** is a small
step (append `{ts, productFingerprint, medianPrice}` per check) and price-drop
alerts are a small step after that. Explicitly **not** in this plan — but D6's
schema is designed not to block it, which is why `lastChangedAt` and the rolling
stats exist rather than a bare `lastCheckedAt`.

**Acceptance for D10:** with `AUTO_REFRESH=true` and a fixture-backed fake clock,
a 50-record registry produces a bounded, non-overlapping, jittered check schedule;
an unchanged page costs exactly one fetch; a 404'd page is parked after 2 misses;
a pinned page is never demoted.

---

## Efficiency budget (the target to hold yourself to)

| Scenario | Fetches | Renders | Wall-clock |
|---|---|---|---|
| **Scheduled refresh, page unchanged** | **1** | 0 | **~1 s**, no scrape at all |
| **Warm registry, pages still live** | 1–3 | 0 | **~2 s** + scrape |
| Cold, nav hit (typical SSR storefront) | 3–6 | 0 | ~6 s + scrape |
| Cold, sitemap needed | 6–10 | 0 | ~12 s + scrape |
| Cold, probes needed (unknown platform) | 12–18 | 0 | ~22 s + scrape |
| Cold, SPA shell (worst case) | 8–14 | 1 | ~30 s + scrape |
| Budget exhausted | 20 (hard cap) | 1 | 45 s (hard cap) |

Four invariants keep this honest:
1. **The homepage is fetched exactly once** and reused for platform detection,
   link harvest, root verification and render detection.
2. **Verification HTML is handed to the scraper** — a selected page is never
   downloaded twice.
3. **Every tier can be skipped**, and on a well-built storefront tiers 2–4 are.
4. **An unchanged page is never scraped.** The fingerprint check (D10.3 step 2)
   is what makes a 200-URL watchlist cost roughly 200 GETs a day rather than
   200 crawls.

---

## Dependency graph

```
D0 (types + fixtures)
 │  ← blocks everything; every heuristic below fails silently
 ├────────────┬──────────────┐
 ▼            ▼              ▼
D1 (guards)  D2 (lexicon+scorer)   ← both pure, both parallelizable
 │            │
 └─────┬──────┘
       ▼
      D3 (sources)          ← D1 gates every fetch; D2 ranks every find
       │
       ▼
      D4 (verification + dedupe)
       │  ← "which pages are real" must exist before budgets mean anything
       ├──────────────┐
       ▼              ▼
      D5 (frontier)  D9 (degradation)
       │
       ▼
      D6 (registry + memo)  ← needs a verified score to know what "worked" means
       │
       ├──────────────┐
       ▼              ▼
      D7 (API)       D10 (scheduler)   ← consumes the registry; needs nothing else
       │
       ▼
      D8 (client)
```

**Critical path:** D0 → D2 → D3 → D4 → D6. D1 is small, independent, and must
land before any code fetches a discovered URL — treat it as part of D0's gate.
D10 needs only D6, so the scheduler and the UI can be built in parallel.

---

## Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| **SSRF surface expansion** — we now fetch URLs read from remote HTML | Open proxy / request amplification; the project's worst failure mode | Same-site eTLD+1 guard (D1.1) **plus** the existing `assertPublicUrl` on every hop, applied to sitemap URLs too. Cross-site is an off-by-default, loudly-logged flag. |
| False positives (`/wholesale`, `/blog/best-deals`) | Wasted crawl, garbage results | Token-boundary matching (not substring), STOP segments, NEG tokens, and verification gating on measured deal density |
| False negatives — merchant uses an unguessable word (`/bonanza`, `/utsob`) | Deals missed silently | Merchant's own anchor text scores highest; sitemap recall; user pin/exclude (D8); lexicon extensible via JSON without a code change |
| Budget blowout on a huge sitemap index | 45 s discovery, or worse | Hard caps at every level: 4 documents, 5 MB each, keyword-gated index recursion, early exit at 200 matches |
| Faceted nav generates thousands of candidates | Frontier never converges | Canonicalization drops non-meaningful params; ≥3-param penalty; `maxCandidates` cap |
| Registry serves dead campaign URLs | Confident 404s | Mandatory cheap re-verification before every use, park at 2 misses, full re-discovery when half the list dies |
| Registry rot — thousands of parked rows nobody wants | A useless list, slow scans | Cap + eviction order (§D6.3), `seasonHint`-driven `revisitAfter` instead of blind retries, Saved Pages view makes rot visible and one click removable |
| **Unattended scheduler bans the IP or eats the box** | Everything stops working, silently, while nobody is watching | Off by default; same rate limiter / robots / SSRF as user requests, no privileges; 1 domain per tick, no overlapping ticks, hourly browser cap, back off on blocks, pause on cross-domain failure bursts |
| A user's "no" gets rediscovered every run | Wasted fetches, the tool feels like it isn't listening | `excluded` is a remembered terminal state filtered *before* scoring — distinct from `DELETE` |
| Registry file corrupted or lost | Loses curated work, not just time | Atomic write + `.bak` + loud failure (not the caches' silent start-fresh), plus JSON/CSV export as the backup story |
| Aggressive discovery gets the IP banned | Everything stops working | Discovery inherits `hostRateLimiter` and the robots check; a 20-fetch cap is *lighter* than one existing scrape's load |
| Duplicate listings triple the scrape cost | Slow, self-matching comparisons | Fingerprint dedupe (D4.4) **before** the expensive scrape |
| Platform probe packs read as site-specific code | Erodes the project's core principle | They key off a **fingerprint**, never a hostname, and apply to every site on that platform. `siteNameFromUrl`'s `KNOWN_SITES` map must **not** grow — it is cosmetic naming only. |
| Discovery adds 25 s before the first product | Feels broken | Streamed `discovering`/`verifying` events, warm-memo fast path, honest budget table above |

---

## Explicitly out of scope

Stated so they don't creep in:

- **General web crawling.** One registrable domain, depth ≤ 2, hard budget.
- **Search-engine querying** (`site:x.com flash sale`). Effective, but it adds an
  external dependency, ToS exposure and a rate-limited third party in the hot
  path. Revisit only if D3 recall proves genuinely insufficient.
- **Third-party deal aggregators / affiliate feeds.** Different product entirely.
- **Anything behind a login.** Member-only deals are out.
- **Defeating access controls.** Discovery respects `robots.txt` under the same
  flags as the scraper. Unchanged from SCRAPER_PLAN's position: this is for
  reliability on public listings.

---

## Definition of done

- `POST /api/scrape { targets: ["chaldal.com"] }` returns deals with **no path
  supplied by the user**, and a `DiscoveryReport` explaining every selection *and
  every rejection*
- Zero site-specific branches in `server/src/discovery/` — verified by review;
  `KNOWN_SITES` has not grown
- Every discovered URL passes canonicalization → same-site → SSRF → robots →
  rate limiter before any fetch; a fixture proves an off-site link is rejected
- Discovery is fully fixture-tested and **network-free** in CI; precision@5 ≥ 0.8
- Hard budget provably enforced: a synthetic 500-candidate site completes within
  `maxFetches` and reports `budgetExhausted: true` rather than hanging
- A second run against a known domain skips discovery and starts scraping in
  under ~2 s
- **Every verified URL is saved** — including the ones that lost the top-K cut —
  and survives a server restart
- **`POST /api/scrape` with no targets scrapes the saved list**, no domain typed
- The Saved Pages view lists every record with label, health and next check;
  pin / exclude / refresh / delete / export all work
- A dead campaign URL is **parked with a `revisitAfter`**, not deleted and not
  retried forever; a pinned record is never demoted by any automatic rule
- With `AUTO_REFRESH=true`, the scheduler runs bounded, non-overlapping,
  jittered ticks; an unchanged page costs exactly **one fetch and no scrape**
- Killing the process mid-tick leaves a valid registry file
- Duplicate listings are collapsed before the expensive scrape, not after
- Every knob is in `config.discovery` and documented in `.env.example`; no
  `process.env` read outside `config.ts`
