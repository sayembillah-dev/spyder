import stringSimilarity from 'string-similarity';
import type { ComparisonGroup, ScrapedProduct } from '../types';
import { makeId } from '../utils/price';
import { config } from '../config';

const DEFAULT_THRESHOLD = config.match.threshold;
const SAME_SITE_PENALTY = config.match.sameSitePenalty; // discourage grouping duplicates from one store
/**
 * Price-sanity veto. Titles alone happily match a phone to its case, or a
 * 2kg bag to a 250g sachet — and because groups are ranked by `savings`, those
 * bogus pairs sort straight to the TOP of the comparison view. Real
 * cross-store spread on the same SKU is tens of percent; a multiple this
 * large means the two listings are not the same product.
 */
const MAX_PRICE_RATIO = config.match.maxPriceRatio;

/**
 * Words that appear in thousands of unrelated listings. They inflate naive
 * string similarity (two different fans both say "mini portable usb
 * rechargeable fan"), so they carry no weight in token matching.
 */
const GENERIC_TOKENS = new Set([
  'new', 'hot', 'deal', 'offer', 'free', 'best', 'original', 'genuine', 'authentic',
  'mini', 'portable', 'usb', 'rechargeable', 'wireless', 'electric', 'smart',
  'multi', 'color', 'colour', 'pack', 'combo', 'pcs', 'pc', 'of', 'and', 'with',
  'high', 'quality', 'big', 'large', 'small', 'digital', 'led', 'home', 'kitchen',
  'use', 'shop', 'for', 'the', 'a', 'in', 'bd', 'series', 'model', 'official',
]);

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(pack of|pcs|pc|pack|combo|free|offer|new|hot|deal|সাথে)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Content tokens = normalized words minus generic e-commerce filler. */
function contentTokens(norm: string): Set<string> {
  return new Set(
    norm.split(' ').filter((w) => w.length >= 2 && !GENERIC_TOKENS.has(w)),
  );
}

/**
 * Model-identity tokens: letter+digit mixes ("x688", "wqp12", "na110") or
 * 4+ digit series numbers ("5000" in Philips 5000). These discriminate
 * products far better than descriptors.
 */
function modelTokens(tokens: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    if (t.length >= 3 && /[a-z]/.test(t) && /\d/.test(t) && /^[a-z0-9]+$/.test(t)) out.add(t);
    else if (/^\d{4,}$/.test(t)) out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

interface GroupAcc {
  rep: string;
  repNorm: string;
  repTokens: Set<string>;
  repModels: Set<string>;
  items: ScrapedProduct[];
  minPrice: number;
  maxPrice: number;
}

/**
 * Greedy title-similarity clustering.
 * Score = ½ char-bigram similarity + ½ content-token Jaccard, with a hard
 * veto when both sides carry model numbers that share nothing (a Philips
 * NA110 fryer is never an HD9285), and a second hard veto when the resulting
 * price spread would exceed MAX_PRICE_RATIO. Only groups spanning ≥ 2 source
 * sites are returned — those are real comparisons.
 */
export function buildComparisonGroups(
  products: ScrapedProduct[],
  threshold: number = DEFAULT_THRESHOLD,
): ComparisonGroup[] {
  const groups: GroupAcc[] = [];

  for (const p of [...products].sort((a, b) => a.dealPrice - b.dealPrice)) {
    const norm = normalizeTitle(p.title);
    if (norm.length < 4) continue;
    const tokens = contentTokens(norm);
    const models = modelTokens(tokens);

    let best: GroupAcc | null = null;
    let bestScore = 0;
    for (const g of groups) {
      // hard veto: joining would stretch the group past a believable spread.
      // Tracked explicitly rather than inferred from the price-sorted walk, so
      // the guard survives any change to iteration order.
      const lo = Math.min(g.minPrice, p.dealPrice);
      const hi = Math.max(g.maxPrice, p.dealPrice);
      if (lo <= 0 || hi / lo > MAX_PRICE_RATIO) continue;

      // hard veto: cross-currency comparison is meaningless while
      // detectCurrency defaults unknowns to BDT — a USD listing must never
      // join a BDT group and produce a fictitious "savings".
      if (g.items[0]!.currency !== p.currency) continue;

      // hard veto: conflicting model identities ("x688" vs "hd9285")
      if (models.size && g.repModels.size) {
        let shared = 0;
        for (const m of models) if (g.repModels.has(m)) shared += 1;
        if (shared === 0) continue;
      }
      let score =
        0.5 * stringSimilarity.compareTwoStrings(norm, g.repNorm) +
        0.5 * jaccard(tokens, g.repTokens);
      if (g.items.some((i) => i.sourceSite === p.sourceSite)) score -= SAME_SITE_PENALTY;
      if (score > bestScore) {
        bestScore = score;
        best = g;
      }
    }

    if (best && bestScore >= threshold) {
      best.items.push(p);
      best.minPrice = Math.min(best.minPrice, p.dealPrice);
      best.maxPrice = Math.max(best.maxPrice, p.dealPrice);
    } else {
      groups.push({
        rep: p.title,
        repNorm: norm,
        repTokens: tokens,
        repModels: models,
        items: [p],
        minPrice: p.dealPrice,
        maxPrice: p.dealPrice,
      });
    }
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
