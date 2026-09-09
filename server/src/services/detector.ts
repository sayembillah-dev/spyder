import axios from 'axios';
import * as cheerio from 'cheerio';
import { browserHeaders } from '../utils/userAgents';
import { assertPublicUrl } from '../utils/ssrf';
import { hostRateLimiter } from '../utils/rateLimit';
import { throwIfAborted } from '../utils/abort';
import { config } from '../config';
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

const MAX_REDIRECT_HOPS = 5;

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

/** Statuses worth ONE retry with a fresh fingerprint — transient rate-limits/sheds. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * HTTP failure carrying the server's status, so callers can tell
 * "server answered but refused us" (→ escalate to a real browser)
 * from "site is gone" (→ fatal). Universal signal — no site identity.
 */
export class FetchHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Request failed with status code ${status}`);
    this.name = 'FetchHttpError';
  }
}

/**
 * Fetch raw HTML with a realistic, randomized browser fingerprint.
 * Rate-limit-ish answers get one retry after a jittered pause with a fresh
 * fingerprint; failures rethrow as FetchHttpError (status attached) when the
 * server answered, or the raw network error when nothing answered.
 */
export async function fetchHtml(url: string, signal?: AbortSignal): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfAborted(signal);
    if (attempt > 0) {
      // Honour Retry-After when the server named a delay; otherwise jitter.
      const retryAfter = axios.isAxiosError(lastErr)
        ? lastErr.response?.headers?.['retry-after']
        : undefined;
      const named = retryAfter ? Number(retryAfter) * 1000 : NaN;
      await new Promise((r) =>
        setTimeout(r, Number.isFinite(named) ? Math.min(named, 15_000) : 1500 + Math.floor(Math.random() * 1500)),
      );
    }
    try {
      return await fetchFollowingRedirects(url, signal);
    } catch (e) {
      throwIfAborted(signal); // axios surfaces our cancel as a generic error — normalize it
      lastErr = e;
      const status = axios.isAxiosError(e) ? e.response?.status : undefined;
      if (status === undefined || !RETRYABLE_STATUSES.has(status)) break;
    }
  }
  if (axios.isAxiosError(lastErr) && lastErr.response?.status !== undefined) {
    throw new FetchHttpError(lastErr.response.status);
  }
  throw lastErr;
}

/**
 * One guarded HTTP fetch. Redirects are followed MANUALLY: axios'
 * maxRedirects would follow a public URL's 302 straight into a private
 * address, so every hop re-validates through the SSRF guard.
 */
async function fetchFollowingRedirects(url: string, signal?: AbortSignal): Promise<string> {
  let current = await assertPublicUrl(url);
  const headers = browserHeaders(); // one fingerprint per call — fresh on retry
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    throwIfAborted(signal);
    await hostRateLimiter.waitTurn(current.hostname); // one in flight per host
    const res = await axios.get<string>(current.href, {
      headers,
      signal,
      timeout: config.detect.timeoutMs,
      maxRedirects: 0,
      responseType: 'text',
      validateStatus: (s) => s >= 200 && s < 400,
      maxContentLength: 15 * 1024 * 1024,
    });
    const location = res.headers.location as string | undefined;
    if (res.status >= 300 && res.status < 400 && location) {
      current = await assertPublicUrl(new URL(location, current).href);
      continue;
    }
    return typeof res.data === 'string' ? res.data : String(res.data);
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECT_HOPS})`);
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
export async function detectRenderingType(url: string, signal?: AbortSignal): Promise<DetectionResult> {
  const html = await fetchHtml(url, signal);
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
  else score -= 2; // product shells without prices = JS-hydrated (e.g. Othoba) → needs a browser
  if (productNodes >= 3) score += 2;
  if (hasNextData) score += 2;
  if (text.length > 2500) score += 1;
  if (framework) score -= 2;
  if (text.length < 1200) score -= 2;

  const renderType: RenderType = score >= 1 ? 'SSR' : 'CSR';
  return { url, renderType, html, framework, textLength: text.length, hasPrices };
}
