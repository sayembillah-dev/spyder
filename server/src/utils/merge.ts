import type { ScrapedProduct } from '../types';

/**
 * The one definition of "these two extractions are the same listing".
 *
 * Title + deal price is deliberately coarse: the same product reached by two
 * strategies (JSON payload vs DOM card) or seen twice across page states must
 * collapse, while two genuinely different SKUs that happen to share a price
 * keep their distinct titles. Lives here so the extractor, the SSR walker and
 * the browser accumulator can never disagree about it.
 */
export const productKey = (p: ScrapedProduct): string =>
  `${p.title.toLowerCase()}|${p.dealPrice}`;

/**
 * Dedupe-and-enrich accumulator shared by every scrape path.
 *
 * A duplicate is never simply dropped — each strategy is strong in different
 * places (the JSON path nails prices but often carries no image or link; the
 * DOM path has both but weaker prices), so a repeat visit backfills whatever
 * the incumbent is missing. Once the cap is reached new products stop being
 * admitted, but existing ones keep getting enriched.
 */
export class ProductMerger {
  private readonly byKey = new Map<string, ScrapedProduct>();
  /** Page URLs seen so far — a productUrl equal to one of these is a
   *  page-level fallback, not a real product link, and may be upgraded. */
  private readonly pageUrls = new Set<string>();

  constructor(private readonly cap: number) {}

  /**
   * Merge one extracted batch. `pageUrl` is the document the batch came from,
   * so link backfill can tell a real product link from the fallback the
   * extractor uses when a card has no anchor.
   * Returns how many products were genuinely new.
   */
  add(batch: ScrapedProduct[], pageUrl?: string): number {
    if (pageUrl) this.pageUrls.add(pageUrl);

    let added = 0;
    for (const p of batch) {
      const key = productKey(p);
      const existing = this.byKey.get(key);

      if (!existing) {
        if (this.byKey.size >= this.cap) continue;
        this.byKey.set(key, p);
        added += 1;
        continue;
      }

      if (!existing.imageUrl && p.imageUrl) existing.imageUrl = p.imageUrl;

      // Upgrade a page-level fallback link to a real product link. Checking
      // against every page URL seen (not just the current one) matters on
      // multi-page scrapes, where the incumbent's fallback came from an
      // earlier page than the batch now offering the real link.
      if (
        this.pageUrls.has(existing.productUrl) &&
        p.productUrl &&
        !this.pageUrls.has(p.productUrl)
      ) {
        existing.productUrl = p.productUrl;
      }

      if (
        existing.originalPrice === null &&
        p.originalPrice !== null &&
        p.originalPrice > existing.dealPrice
      ) {
        existing.originalPrice = p.originalPrice;
        if (existing.discountPercentage === null) {
          existing.discountPercentage = p.discountPercentage;
        }
      }
    }
    return added;
  }

  get size(): number {
    return this.byKey.size;
  }

  values(): ScrapedProduct[] {
    return [...this.byKey.values()];
  }
}
