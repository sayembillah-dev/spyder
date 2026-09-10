import { createHash } from 'node:crypto';
import type { ScrapedProduct } from '../types';

/**
 * D4.4 — product-set fingerprinting.
 *
 * /deals, /collections/sale and /offers?sort=popular routinely serve the
 * SAME product set. Scraping all three triples the cost for zero new
 * products and inflates comparisons with self-matches. The fingerprint is
 * a hash of the top-N normalized titles; Jaccard over the title sets
 * decides "same listing".
 */

const TOP_N = 20;

/** Lowercase, strip punctuation/diacritics, collapse spaces — two spellings
 *  of one product should collide. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ঀ-৿ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalized top-N titles, sorted for order-independence. */
export function titleSet(products: ScrapedProduct[], n: number = TOP_N): Set<string> {
  const titles = products
    .map((p) => normalizeTitle(p.title))
    .filter(Boolean)
    .sort()
    .slice(0, n);
  return new Set(titles);
}

/** Stable hash of the title set — stored on VerificationResult. */
export function productFingerprint(products: ScrapedProduct[]): string {
  const titles = [...titleSet(products)].sort();
  return createHash('sha1').update(titles.join('')).digest('hex').slice(0, 16);
}

/** Jaccard similarity ≥ 0.80 ⇒ same listing. */
export const DUPLICATE_JACCARD = 0.8;

export function fingerprintOverlap(a: ScrapedProduct[], b: ScrapedProduct[]): number {
  const sa = titleSet(a);
  const sb = titleSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * D4.4 — collapse candidates serving the SAME product set. Runs AFTER
 * verification (the cheap pass already fetched the products) and BEFORE the
 * expensive full scrape. Jaccard ≥ 0.80 ⇒ same listing: keep the higher
 * finalScore, record the loser as 'duplicate-of: <url>'.
 */
export function dedupeCandidates<T extends { url: string; finalScore?: number }>(
  verified: Array<{ candidate: T; products: ScrapedProduct[] }>,
): { kept: T[]; dupes: Array<{ url: string; duplicateOf: string }> } {
  // Highest-scored first so the survivor is always the stronger candidate.
  const sorted = [...verified].sort(
    (x, y) => (y.candidate.finalScore ?? 0) - (x.candidate.finalScore ?? 0),
  );
  const kept: Array<{ candidate: T; products: ScrapedProduct[] }> = [];
  const dupes: Array<{ url: string; duplicateOf: string }> = [];

  for (const v of sorted) {
    const match = kept.find(
      (k) => fingerprintOverlap(k.products, v.products) >= DUPLICATE_JACCARD,
    );
    if (match) dupes.push({ url: v.candidate.url, duplicateOf: match.candidate.url });
    else kept.push(v);
  }
  return { kept: kept.map((k) => k.candidate), dupes };
}
