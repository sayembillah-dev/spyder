import { fetchHtml } from './detector';
import { throwIfAborted } from '../utils/abort';
import { extractProductsFromHtml } from './extractor';
import { findNextPageUrl } from './pagination';
import { ProductMerger } from '../utils/merge';
import { config } from '../config';
import type { ScrapedProduct } from '../types';

const MAX_SSR_PAGES = config.scrape.maxPages;
const MAX_PRODUCTS_TOTAL = config.caps.total;

export type ProgressSink = (message: string) => void;

/**
 * Scrape a server-rendered listing, following pagination when present.
 *
 * Page 1 HTML comes free from the detection phase (no refetch). We then
 * walk next-page links (?page=2, /page/3/, rel="next", …) with plain
 * axios fetches — SSR pagination means each page is a full document, so
 * no browser is ever needed. Products merge with the extractor's
 * title|price dedupe; the walk stops on a repeated URL, a page with no
 * new products, or the safety caps.
 */
export async function scrapeSsrSite(
  firstHtml: string,
  url: string,
  site: string,
  onProgress: ProgressSink = () => {},
  extraCardSelectors: string[] = [],
  signal?: AbortSignal,
): Promise<ScrapedProduct[]> {
  const merger = new ProductMerger(MAX_PRODUCTS_TOTAL);
  const visited = new Set<string>([url]);

  const collect = (html: string, pageUrl: string): number =>
    merger.add(extractProductsFromHtml(html, pageUrl, site, extraCardSelectors), pageUrl);

  collect(firstHtml, url);

  let currentUrl = url;
  let currentHtml = firstHtml;

  for (let pg = 2; pg <= MAX_SSR_PAGES; pg++) {
    throwIfAborted(signal);
    const nextUrl = findNextPageUrl(currentHtml, currentUrl);
    if (!nextUrl || visited.has(nextUrl)) break;
    visited.add(nextUrl);

    let html: string;
    try {
      html = await fetchHtml(nextUrl, signal);
    } catch {
      throwIfAborted(signal); // cancellation is not "a dead link"
      break; // a dead next link shouldn't sink the pages we already have
    }

    const added = collect(html, nextUrl);
    onProgress(`📄 Page ${pg} fetched — ${merger.size} deals so far…`);

    if (added === 0) break; // listing repeats first page → last page reached
    if (merger.size >= MAX_PRODUCTS_TOTAL) break;

    currentUrl = nextUrl;
    currentHtml = html;
  }

  return merger.values();
}
