import { readFileSync } from 'node:fs';
import { config } from '../config';

/**
 * D2.1/D2.2 — the deal lexicon: DATA, not logic.
 *
 * Precision comes from TOKEN-BOUNDARY matching: `tokenize('/wholesale-buyers')`
 * → ['wholesale','buyers'] — the token 'sale' never appears, so it never
 * matches. Substring matching is why naive versions of this system scrape
 * /wholesale, /salem-store-locator and /sales-tax-policy.
 *
 * Extendable from DISCOVERY_LEXICON_PATH (JSON) so a user can add a language
 * without a code change:
 *   { "A": ["soldes"], "B": ["boxing day"], "C": [], "BN": [], "NEG": [],
 *     "STOP": [], "SEASON": { "soldes": [1, 7] } }
 */

/** Split on non-alphanumerics AND camelCase, keeping Bangla as word chars. */
export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9ঀ-৿]+/)
    .filter(Boolean);
}

export interface Lexicon {
  /** token/bigram → weight 0..1 */
  weights: Map<string, number>;
  /** Tier-B token → months (1-12) it is in season */
  season: Map<string, number[]>;
  /** tokens that are explicit rejects even though they contain "sale"-ish text */
  neg: Set<string>;
  /** path segments that can never be a deal hub (blog, careers, cart, …) */
  stop: Set<string>;
}

/* Tier A — explicit deal intent (1.00). */
const TIER_A = [
  'deal', 'deals', 'discount', 'discounts', 'offer', 'offers', 'sale', 'sales',
  'clearance', 'outlet', 'promo', 'promotion', 'promotions', 'flash sale',
  'flashsale', 'hot deals', 'daily deals', 'deal of the day', 'price drop',
  'markdown', 'liquidation', 'blowout', 'doorbuster', 'bargain', 'on sale',
  'super saver',
];

/* Tier B — campaign / seasonal (0.90, +0.10 in season, damped to 0.45 out). */
const TIER_B = [
  'black friday', 'cyber monday', 'singles day', '11.11', '12.12',
  'boxing day', 'summer sale', 'winter sale', 'eid', 'eid offer', 'ramadan',
  'boishakh', 'pohela boishakh', 'puja', 'christmas', 'new year sale',
  'anniversary sale', 'mega sale', 'back to school', 'campaign',
];

/* Tier C — weak / supporting (0.45). */
const TIER_C = [
  'save', 'savings', 'special', 'budget', 'combo', 'bundle',
  'lowest price', 'best price', 'under',
];

/* Bangla — 1.00 strong, 0.90 campaign-ish. */
const TIER_BN_STRONG = ['ছাড়', 'অফার', 'ডিসকাউন্ট', 'সেল', 'ফ্ল্যাশ সেল', 'বিশেষ ছাড়', 'মূল্যছাড়'];
const TIER_BN_WEAK = ['ক্যাম্পেইন'];

/* Explicit rejects — words that are genuinely their own word. */
const NEG = ['wholesale', 'resale', 'salesman', 'salesforce', 'salem', 'saletax'];

/* Path segments that can never host a deal listing. */
const STOP = [
  'blog', 'news', 'article', 'press', 'help', 'faq', 'support', 'terms',
  'privacy', 'policy', 'policies', 'careers', 'jobs', 'about', 'contact',
  'login', 'signin', 'register', 'cart', 'checkout', 'account', 'wishlist',
  'compare', 'return', 'refund', 'shipping', 'track', 'review', 'reviews',
];

/** A "Black Friday" link in November is a live campaign; in March it is a
 *  stale archive. Out-of-season Tier-B tokens are not rejected — damped. */
const SEASON_DATA: Record<string, number[]> = {
  'black friday': [11],
  'cyber monday': [11, 12],
  christmas: [11, 12],
  'summer sale': [4, 5, 6, 7],
  eid: [3, 4, 5, 6],
  'eid offer': [3, 4, 5, 6],
  boishakh: [4],
  'pohela boishakh': [4],
  '11.11': [11],
  '12.12': [12],
  'back to school': [7, 8, 9],
};

interface LexiconFile {
  A?: string[];
  B?: string[];
  C?: string[];
  BN?: string[];
  NEG?: string[];
  STOP?: string[];
  SEASON?: Record<string, number[]>;
}

function addWeighted(weights: Map<string, number>, tokens: string[], weight: number): void {
  for (const t of tokens) {
    // normalize multi-word entries to the token stream form ('Flash Sale' → 'flash sale')
    const norm = tokenize(t).join(' ');
    if (norm) weights.set(norm, weight);
  }
}

export function loadLexicon(path: string | null = config.discovery.lexiconPath): Lexicon {
  const weights = new Map<string, number>();
  addWeighted(weights, TIER_A, 1.0);
  addWeighted(weights, TIER_BN_STRONG, 1.0);
  addWeighted(weights, TIER_B, 0.9);
  addWeighted(weights, TIER_BN_WEAK, 0.9);
  addWeighted(weights, TIER_C, 0.45);
  const neg = new Set(NEG);
  const stop = new Set(STOP);
  const season = new Map<string, number[]>(
    Object.entries(SEASON_DATA).map(([k, v]) => [tokenize(k).join(' '), v]),
  );

  if (path) {
    try {
      const extra = JSON.parse(readFileSync(path, 'utf8')) as LexiconFile;
      if (extra.A) addWeighted(weights, extra.A, 1.0);
      if (extra.B) addWeighted(weights, extra.B, 0.9);
      if (extra.C) addWeighted(weights, extra.C, 0.45);
      if (extra.BN) addWeighted(weights, extra.BN, 1.0);
      extra.NEG?.forEach((t) => neg.add(t));
      extra.STOP?.forEach((t) => stop.add(t));
      for (const [k, v] of Object.entries(extra.SEASON ?? {})) {
        season.set(tokenize(k).join(' '), v);
      }
    } catch (err) {
      console.warn(`[discovery] failed to load lexicon from ${path}:`, err);
    }
  }
  return { weights, season, neg, stop };
}

/** Process-wide lexicon, built once (env is immutable after boot anyway). */
let cached: Lexicon | null = null;
export function lexicon(): Lexicon {
  if (!cached) cached = loadLexicon();
  return cached;
}

/** Edit distance ≤ 1 (one substitution, insertion or deletion). */
function editDistance1(a: string, b: string): boolean {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i++) if (a[i] !== b[i] && ++diff > 1) return false;
    return true;
  }
  // one insertion/deletion
  const [short, long] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
    } else if (!skipped) {
      skipped = true;
      j++;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Misspellings merchants actually ship: /clearence, /discout, /speical-offer.
 * Bounded edit-distance-1 against TIER A ONLY, and never against short tokens
 * (sale/sales/sold/sole are one edit apart — fuzziness there is a bug farm;
 * 'salem' must never reach 'sales'). The 6-char floor keeps sale/sales/deals
 * out of the candidate set entirely.
 */
const FUZZY_MIN_LENGTH = 6;
const FUZZY_CANDIDATES = TIER_A.filter((t) => !t.includes(' ') && t.length >= FUZZY_MIN_LENGTH);

function fuzzyTierAMatch(token: string): string | null {
  if (token.length < FUZZY_MIN_LENGTH) return null;
  for (const cand of FUZZY_CANDIDATES) {
    if (editDistance1(token, cand)) return cand;
  }
  return null;
}

export interface KeywordScore {
  /** 0..1 — best keyword weight found, 0 when nothing matched. */
  weight: number;
  /** Evidence strings, e.g. ['kw:"flash sale"=1.0', 'kw-season:+0.10']. */
  evidence: string[];
}

/**
 * Best keyword weight over a text fragment (anchor text, path, title).
 * Matches unigrams AND bigrams ('flash sale' carries far more signal than
 * either half alone). Seasonal tokens get +0.10 in season, damped to 0.45
 * out of season.
 */
export function keywordScore(text: string, now: Date = new Date()): KeywordScore {
  const { weights, season } = lexicon();
  const tokens = tokenize(text);
  const evidence: string[] = [];
  let best = 0;

  const consider = (phrase: string, base: number) => {
    let w = base;
    const months = season.get(phrase);
    if (months) {
      const inSeason = months.includes(now.getMonth() + 1);
      if (inSeason) {
        w = Math.min(1, w + 0.1);
        evidence.push(`kw-season:"${phrase}"+0.10`);
      } else {
        w = 0.45; // out of season: damped, never rejected
        evidence.push(`kw-offseason:"${phrase}"→0.45`);
      }
    }
    evidence.push(`kw:"${phrase}"=${w.toFixed(2)}`);
    if (w > best) best = w;
  };

  // unigrams + bigrams
  for (let i = 0; i < tokens.length; i++) {
    const uni = tokens[i]!;
    const w1 = weights.get(uni);
    if (w1 !== undefined) consider(uni, w1);
    else {
      const fixed = fuzzyTierAMatch(uni);
      if (fixed) {
        // Tier-A misspellings keep the full weight — the intent is unambiguous.
        evidence.push(`kw-fuzzy:"${uni}"→"${fixed}"=1.00`);
        best = 1;
      }
    }
    if (i + 1 < tokens.length) {
      const bi = `${uni} ${tokens[i + 1]}`;
      const w2 = weights.get(bi);
      if (w2 !== undefined) consider(bi, w2);
    }
  }
  return { weight: best, evidence };
}

/** Hard-reject token present? ('wholesale', 'resale', …) */
export function hasNegToken(text: string): string | null {
  const { neg } = lexicon();
  for (const t of tokenize(text)) if (neg.has(t)) return t;
  return null;
}

/** First STOP segment in a path, or null. Compares whole segments only. */
export function stopSegmentInPath(pathname: string): string | null {
  const { stop } = lexicon();
  for (const seg of pathname.split('/')) {
    for (const t of tokenize(seg)) if (stop.has(t)) return t;
  }
  return null;
}
