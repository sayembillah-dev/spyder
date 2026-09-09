import type { ScrapedProduct } from '../types';

/**
 * Extraction quality scoring — the measurement layer.
 *
 * Counting products is not enough: a page yielding 8 pieces of garbage
 * (nav items with prices, a "related products" sidebar) looks exactly like
 * a complete scrape when the only escalation signal is `length === 0`.
 * This score is what the ladder escalates on, what the Phase 4 cache uses
 * to decide whether a strategy "worked", and what the UI shows as
 * confidence.
 */
export interface ExtractionQuality {
  score: number; // 0..1
  productCount: number;
  /** productUrl !== the page-level fallback — structural inference grabbing
   *  containers instead of cards shows up here first. */
  pctWithRealLink: number;
  pctWithImage: number;
  /** Deal pages should mostly show a strike-through; near-zero suggests
   *  the wrong elements matched. */
  pctWithOriginalPrice: number;
  /** "1,234 products found" parsed from the page, when present. */
  claimedTotal: number | null;
  /** productCount / claimedTotal — the strongest pagination signal. */
  coverage: number | null;
  flags: string[];
}

/** "1,234 products" / "showing 24 of 1,234" / "২৩৪টি পণ্য" — Bengali included. */
const CLAIMED_RES = [
  /(?:of|out of|from)\s+(\d[\d,]*)\s+(?:products?|items?|results?)/i,
  /(\d[\d,]*)\s*(?:products?|items?|results?)\s*(?:found|available)?/i,
  /(\d[\d,]*)\s*টি?\s*(?:পণ্য|আইটেম)/i,
];

/** Max plausible same-listing price spread before "mixed widgets" is suspected. */
const EXTREME_VARIANCE_RATIO = 500;

export function parseClaimedTotal(html: string): number | null {
  // strip tags — the claim lives in visible text
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  for (const re of CLAIMED_RES) {
    const m = text.match(re);
    if (m) {
      const n = parseInt(m[1]!.replace(/,/g, ''), 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

export function scoreExtraction(
  products: ScrapedProduct[],
  pageUrl: string,
  html?: string,
): ExtractionQuality {
  const productCount = products.length;
  if (productCount === 0) {
    return {
      score: 0,
      productCount: 0,
      pctWithRealLink: 0,
      pctWithImage: 0,
      pctWithOriginalPrice: 0,
      claimedTotal: html ? parseClaimedTotal(html) : null,
      coverage: null,
      flags: ['empty'],
    };
  }

  // A lone product whose link IS the page URL is legitimate (OpenGraph /
  // JSON-LD single-product pages carry no distinct card anchor).
  const realLinks = products.filter(
    (p) => p.productUrl !== pageUrl || productCount === 1,
  ).length;
  const pctWithRealLink = realLinks / productCount;
  const pctWithImage = products.filter((p) => p.imageUrl).length / productCount;
  const pctWithOriginalPrice = products.filter((p) => p.originalPrice !== null).length / productCount;

  const flags: string[] = [];
  let penalty = 1;

  const prices = products.map((p) => p.dealPrice);
  const allIdentical = productCount > 1 && prices.every((n) => n === prices[0]);
  if (allIdentical) {
    // matched a template/placeholder, not real data
    flags.push('all-prices-identical');
    penalty *= 0.3;
  }
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  if (productCount > 2 && lo > 0 && hi / lo > EXTREME_VARIANCE_RATIO) {
    // mixed cards + banners + unrelated widgets
    flags.push('extreme-variance');
    penalty *= 0.7;
  }
  if (pctWithRealLink < 0.5 && productCount > 1) flags.push('mostly-fallback-links');

  const claimedTotal = html ? parseClaimedTotal(html) : null;
  const coverage =
    claimedTotal !== null && claimedTotal >= productCount
      ? productCount / claimedTotal
      : claimedTotal !== null && claimedTotal < productCount
        ? null // claim smaller than what we found → unreliable parse, drop it
        : null;

  // Weighted mix; coverage participates only when the page declares a total.
  const wCoverage = coverage !== null ? 0.25 : 0;
  const totalWeight = 0.35 + 0.25 + 0.15 + wCoverage;
  const raw =
    (0.35 * pctWithRealLink +
      0.25 * pctWithImage +
      0.15 * pctWithOriginalPrice +
      (coverage !== null ? 0.25 * Math.min(coverage, 1) : 0)) /
    totalWeight;

  const score = Math.max(0, Math.min(1, raw * penalty));
  if (coverage !== null && coverage < 0.2) flags.push('low-coverage');

  return {
    score,
    productCount,
    pctWithRealLink,
    pctWithImage,
    pctWithOriginalPrice,
    claimedTotal,
    coverage,
    flags,
  };
}
