# ⚡ FlashDeal Radar

On-demand flash-deal scraping & cross-store price comparison. Paste deal-page URLs, the engine
auto-detects each site's architecture (SSR vs CSR), scrapes with the fastest method, normalizes
prices, and groups matching products across stores.

## Architecture

```
client/   React 18 + Vite + Tailwind v4 + lucide-react (dashboard, SSE live status)
server/   Node.js + TypeScript API
          ├─ services/detector.ts       detectRenderingType(url): axios fetch + SSR/CSR heuristics
          ├─ services/extractor.ts      shared Cheerio extractor:
          │                             ① __NEXT_DATA__ JSON deep-walk  ② generic DOM selectors
          ├─ services/csrScraper.ts     PlaywrightCrawler (headless, random UA, waitForSelector,
          │                             auto-scroll for lazy deals) → page.content() → extractor
          ├─ services/matcher.ts        string-similarity clustering → cross-site comparison groups
          ├─ services/scraperService.ts adaptive router + per-site report + live status events
          └─ utils/                     price normalization (৳/$, commas, Bangla digits), UA pool
```

**Pipeline:** `URL list → detect (parallel, cheap) → route → SSR: Cheerio / CSR: Playwright →
normalize → dedupe → similarity-group → SSE stream to dashboard`

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
  price/discount host lists. Add site-specific classes there.
- **SSR/CSR heuristics**: scoring weights in `server/src/services/detector.ts`.
- **Match strictness**: `DEFAULT_THRESHOLD` in `server/src/services/matcher.ts`
  (raise → fewer, tighter groups).
- **Concurrency / scroll depth / timeouts**: top of `scraperService.ts` / `csrScraper.ts`.
- Known-store display names: `server/src/utils/sites.ts`.
# spyder  
