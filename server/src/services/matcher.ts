import stringSimilarity from 'string-similarity';
import type { ComparisonGroup, ScrapedProduct } from '../types';
import { makeId } from '../utils/price';

const DEFAULT_THRESHOLD = 0.55;
const SAME_SITE_PENALTY = 0.15; // discourage grouping duplicates from one store

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(pack of|pcs|pc|pack|combo|free|offer|new|hot|deal|সাথে)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Greedy title-similarity clustering. Only groups containing items from
 * ≥ 2 different source sites are returned — those are real comparisons.
 */
export function buildComparisonGroups(
  products: ScrapedProduct[],
  threshold: number = DEFAULT_THRESHOLD,
): ComparisonGroup[] {
  const groups: Array<{ rep: string; repNorm: string; items: ScrapedProduct[] }> = [];

  for (const p of [...products].sort((a, b) => a.dealPrice - b.dealPrice)) {
    const norm = normalizeTitle(p.title);
    if (norm.length < 4) continue;

    let best: (typeof groups)[number] | null = null;
    let bestScore = 0;
    for (const g of groups) {
      let score = stringSimilarity.compareTwoStrings(norm, g.repNorm);
      if (g.items.some((i) => i.sourceSite === p.sourceSite)) score -= SAME_SITE_PENALTY;
      if (score > bestScore) {
        bestScore = score;
        best = g;
      }
    }

    if (best && bestScore >= threshold) best.items.push(p);
    else groups.push({ rep: p.title, repNorm: norm, items: [p] });
  }

  return groups
    .filter((g) => new Set(g.items.map((i) => i.sourceSite)).size > 1)
    .map((g) => {
      const items = [...g.items].sort((a, b) => a.dealPrice - b.dealPrice);
      const bestPrice = items[0]!.dealPrice;
      const worstPrice = items[items.length - 1]!.dealPrice;
      const savings = worstPrice - bestPrice;
      return {
        key: makeId(g.repNorm),
        representativeTitle: g.rep,
        items,
        bestPrice,
        worstPrice,
        savings,
        savingsPercent: worstPrice > 0 ? Math.round((savings / worstPrice) * 100) : 0,
      };
    })
    .sort((a, b) => b.savings - a.savings);
}
