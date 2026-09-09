import { scrapeCsrSite } from './csrScraper';
import { detectRenderingType } from './detector';
import { extractProductsFromHtml } from './extractor';
import { buildComparisonGroups } from './matcher';
import { normalizeUrl, siteNameFromUrl } from '../utils/sites';
import type {
  ScrapedProduct,
  ScrapeResult,
  SiteReport,
  SiteStatusEvent,
} from '../types';

const MAX_URLS = 10;
const DETECT_CONCURRENCY = 4;
const SCRAPE_CONCURRENCY = 2; // browsers are heavy — keep parallel CSR runs low

type StatusSink = (e: SiteStatusEvent) => void;

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

/**
 * Adaptive scraper controller.
 * Phase 1 — detect every URL's rendering type in parallel (cheap axios fetches).
 * Phase 2 — route: SSR → Cheerio over the already-fetched HTML (no refetch),
 *           CSR → PlaywrightCrawler with random UA + auto-scroll.
 * Per-site failures never sink the whole run; they land in the report.
 */
export async function scrapeUrls(
  rawUrls: string[],
  onStatus: StatusSink = () => {},
): Promise<ScrapeResult> {
  const started = Date.now();
  const urls = [...new Set(rawUrls.map(normalizeUrl).filter((u): u is string => u !== null))].slice(
    0,
    MAX_URLS,
  );
  if (!urls.length) throw new Error('No valid URLs provided.');

  const report: SiteReport[] = [];

  /* ── Phase 1: architecture detection ─────────────────────────── */
  const detections = await mapWithConcurrency(urls, DETECT_CONCURRENCY, async (url) => {
    const site = siteNameFromUrl(url);
    const t0 = Date.now();
    onStatus({ url, site, phase: 'detecting', message: '🔍 Checking architecture…' });
    try {
      const d = await detectRenderingType(url);
      onStatus({
        url,
        site,
        phase: 'detecting',
        renderType: d.renderType,
        message: `🧭 ${d.renderType} detected${d.framework ? ` (${d.framework})` : ''}`,
      });
      return { ok: true as const, url, site, t0, d };
    } catch (e) {
      const msg = errMsg(e);
      report.push({
        url, site, renderType: null, status: 'error',
        productCount: 0, durationMs: Date.now() - t0, error: msg,
      });
      onStatus({ url, site, phase: 'error', message: `❌ Detection failed: ${msg}` });
      return { ok: false as const };
    }
  });

  /* ── Phase 2: adaptive scraping ──────────────────────────────── */
  const scrapable = detections.filter((x): x is Extract<typeof x, { ok: true }> => x.ok);

  const productSets = await mapWithConcurrency(scrapable, SCRAPE_CONCURRENCY, async ({ url, site, t0, d }) => {
    try {
      let products: ScrapedProduct[];
      if (d.renderType === 'SSR') {
        onStatus({
          url, site, phase: 'scraping', renderType: 'SSR', method: 'fast-html',
          message: `🚀 Scraping ${site} via Fast-HTML…`,
        });
        products = extractProductsFromHtml(d.html, url, site);
      } else {
        onStatus({
          url, site, phase: 'scraping', renderType: 'CSR', method: 'browser',
          message: `⏳ Scrolling ${site} via Browser Automation…`,
        });
        products = await scrapeCsrSite(url, site);
      }
      const durationMs = Date.now() - t0;
      report.push({
        url, site, renderType: d.renderType, status: 'ok',
        productCount: products.length, durationMs,
      });
      onStatus({
        url, site, phase: 'done', renderType: d.renderType, count: products.length, durationMs,
        message: products.length
          ? `✅ ${products.length} deals found in ${(durationMs / 1000).toFixed(1)}s`
          : `⚠️ No deal cards matched on ${site}`,
      });
      return products;
    } catch (e) {
      const msg = errMsg(e);
      report.push({
        url, site, renderType: d.renderType, status: 'error',
        productCount: 0, durationMs: Date.now() - t0, error: msg,
      });
      onStatus({ url, site, phase: 'error', renderType: d.renderType, message: `❌ ${site}: ${msg}` });
      return [] as ScrapedProduct[];
    }
  });

  const products = productSets.flat();
  return {
    products,
    comparisons: buildComparisonGroups(products),
    report,
    totalDurationMs: Date.now() - started,
  };
}
