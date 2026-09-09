import axios from 'axios';
import * as cheerio from 'cheerio';
import { browserHeaders } from '../utils/userAgents';
import type { RenderType } from '../types';

export interface DetectionResult {
  url: string;
  renderType: RenderType;
  /** Raw HTML from the detection fetch — reused by the SSR extractor so we never fetch twice. */
  html: string;
  framework: string | null;
  textLength: number;
  hasPrices: boolean;
}

const FETCH_TIMEOUT_MS = 12_000;

/** Price-like patterns: "৳1,250", "Tk 250", "BDT 250", "$29.99" (incl. HTML entity of ৳). */
const PRICE_HINT =
  /(?:৳|&#2547;|&#x09f3;|Tk\.?|BDT|\$|€|£|₹)\s*[\d,]{2,}|[\d,]{2,}\s*(?:৳|Tk\.?|BDT)/i;

const FRAMEWORK_HINTS: ReadonlyArray<{ re: RegExp; name: string }> = [
  { re: /\/_next\/static|__NEXT_DATA__|\/_next\/image/i, name: 'Next.js' },
  { re: /__NUXT__|\/_nuxt\//i, name: 'Nuxt' },
  { re: /ng-version|_ngcontent|ng-app/i, name: 'Angular' },
  { re: /___gatsby|gatsby-/i, name: 'Gatsby' },
  { re: /data-reactroot|id="root"|id="app"|id="__next"|react-dom|vue(\.min)?\.js/i, name: 'SPA' },
];

/** Fetch raw HTML with a realistic, randomized browser fingerprint. */
export async function fetchHtml(url: string): Promise<string> {
  const res = await axios.get<string>(url, {
    headers: browserHeaders(),
    timeout: FETCH_TIMEOUT_MS,
    maxRedirects: 5,
    responseType: 'text',
    validateStatus: (s) => s >= 200 && s < 400,
    maxContentLength: 15 * 1024 * 1024,
  });
  return typeof res.data === 'string' ? res.data : String(res.data);
}

/**
 * Decide whether a page is server-rendered ('SSR' → cheap Cheerio scrape)
 * or client-rendered ('CSR' → needs a real browser).
 *
 * Scoring model:
 *   +2  visible prices in the stripped body text
 *   +2  product containers present in raw HTML
 *   +2  embedded __NEXT_DATA__ (server-fetched JSON payload)
 *   +1  dense text content
 *   -2  JS framework markers
 *   -2  near-empty app shell
 * score >= 1 → SSR, otherwise CSR.
 */
export async function detectRenderingType(url: string): Promise<DetectionResult> {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const framework = FRAMEWORK_HINTS.find((f) => f.re.test(html))?.name ?? null;
  const hasNextData = $('#__NEXT_DATA__').length > 0;

  $('script, style, noscript, svg, template').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();

  const hasPrices = PRICE_HINT.test(text);
  const productNodes = $(
    '[class*="product" i], [id*="product" i], [data-product], [data-product-id], [itemtype*="Product"]',
  ).length;

  let score = 0;
  if (hasPrices) score += 2;
  if (productNodes >= 3) score += 2;
  if (hasNextData) score += 2;
  if (text.length > 2500) score += 1;
  if (framework) score -= 2;
  if (text.length < 1200) score -= 2;

  const renderType: RenderType = score >= 1 ? 'SSR' : 'CSR';
  return { url, renderType, html, framework, textLength: text.length, hasPrices };
}
