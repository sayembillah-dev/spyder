# ⚡ FlashDeal Radar

On-demand flash-deal scraping & cross-store price comparison. Paste deal-page URLs, the engine
auto-detects each site's architecture (SSR vs CSR), scrapes with the fastest method, normalizes
prices, and groups matching products across stores.

## Architecture

**Design principle: universal, not site-specific.** No per-site branches anywhere. Every
capability is a general strategy, and every escalation is driven by a universal signal —
"the previous strategy extracted **zero products**" — so any storefront, on any stack,
is handled by the same ladder:

```
Rung 0  detect          axios probe with SSR/CSR scoring; a server that ANSWERS BUT
                        REFUSES (401/403/429/5xx — WAF, rate limit, bot wall) is
                        escalated straight to rung 2 instead of erroring out
                        (429/503/etc. first get one jittered retry with a fresh
                        fingerprint — transient sheds usually pass)
Rung 1  fast-html       axios + Cheerio over the detection-fetched HTML, plus a
                        universal "next page" link walker (max 5 pages)
Rung 2  browser         headless Chromium, stealth profile (random UA + browser
                        headers + viewport, font/media blocking)
Rung 3  browser-clean   fully stock Chromium fingerprint (some apps stall
                        hydration under foreign header sets)
```

Inside the extractor the same ladder repeats: ① `__NEXT_DATA__` JSON deep-walk →
② semantic card selectors → ③ structural inference for zero-semantic-markup
storefronts (utility-CSS/Tailwind): every price-shaped text leaf climbs its
ancestors until the subtree outgrows "card size" — the last card-sized ancestor
IS the card. Prices obey one invariant everywhere: **a number is a price only
when anchored to a currency marker, or when it is the entire text of a trusted
price-classed element** — model numbers ("EQ27"), sizes and sold/EMI counters
can never become prices.

Within a browser rung, every discovery mechanism is exhausted and merged:
consent-overlay dismissal → app-boot wait → auto-scroll (lazy content) →
hydration wait (currency-agnostic money text, else DOM-quiescence settle) →
collect → **load-more draining** (real mouse clicks, DOM-snapshot change
detection) → **pagination draining** → **child-frame fallback** (iframe-embedded
storefronts). All page states merge into one deduped result (`title|price` key,
image/price backfill, 200-product safety cap).

```
client/   React 18 + Vite + Tailwind v4 + lucide-react (dashboard, SSE live status)
server/   Node.js + TypeScript API
          ├─ services/detector.ts       detectRenderingType(url): SSR/CSR scoring
          │                             (product shells without prices penalized — JS-hydrated)
          ├─ services/extractor.ts      shared Cheerio extractor: ① __NEXT_DATA__ JSON
          │                             deep-walk ② generic DOM selectors; price-noise
          │                             exclusion (EMI/installment/sold-counter/discount badges)
          ├─ services/ssrScraper.ts     rung 1: Cheerio + universal next-page walker
          ├─ services/pagination.ts     shared load-more/pagination intelligence:
          │                             snapshot-based change detection, trusted clicks,
          │                             aria-disabled handling, Bengali labels (আরও দেখুন/পরবর্তী)
          ├─ services/csrScraper.ts     rungs 2–3: profile ladder + overlay dismissal +
          │                             hydration waits + load-more/pagination draining +
          │                             iframe fallback + multi-state product accumulator
          ├─ services/matcher.ts        hybrid similarity (Dice bigram + content-token
          │                             Jaccard), model-number hard veto, same-site penalty
          ├─ services/scraperService.ts ladder orchestrator + per-site report (incl. winning
          │                             `method`) + live status events
          └─ utils/                     price normalization (৳/$, commas, Bangla digits), UA pool
```

**Pipeline:** `URL list → detect (parallel, cheap) → ladder: fast-html → browser → browser-clean
(escalate on 0 products) → normalize → dedupe → similarity-group → SSE stream to dashboard`

Safety caps (rogue-site bounds): 12 load-more clicks, 2 stale clicks, 5 pages/state walks,
200 products/site, 300s handler timeout.

## Run

```bash
# one-time: install deps
npm install

# one-time: download the Chromium build used for CSR sites
npm run setup:browsers

# launch API (:4000) + dashboard (:5173) together
npm run dev
```

Open http://localhost:5173, paste URLs (one per line), hit **Fetch Live Deals**.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | liveness |
| `POST /api/scrape` | body `{ "urls": string[] }` → full `ScrapeResult` JSON |
| `GET /api/scrape/stream?urls=["…"]` | SSE stream: `site-status` events → `done` (full result) |

## Tuning

- **Selectors**: `server/src/services/extractor.ts` — `CARD_SELECTORS`, `TITLE_SELECTORS`,
  price/discount host lists. Keep them generic — universality beats per-site tweaks.
- **Browser-profile ladder**: `BROWSER_PROFILES` in `server/src/services/csrScraper.ts`
  (add a rung, e.g. a proxied profile, without touching orchestration).
- **SSR/CSR heuristics**: scoring weights in `server/src/services/detector.ts`.
- **Match strictness**: `DEFAULT_THRESHOLD` in `server/src/services/matcher.ts`
  (raise → fewer, tighter groups).
- **Concurrency / scroll depth / timeouts**: top of `scraperService.ts` / `csrScraper.ts`.
- Known-store display names: `server/src/utils/sites.ts`.
# spyder  
