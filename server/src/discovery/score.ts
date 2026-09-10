import type { CandidateSource } from '../types';
import { hasNegToken, keywordScore, stopSegmentInPath, tokenize } from './lexicon';

/**
 * D2.3 — the prior score: P("this URL is a deal listing") computed BEFORE
 * spending a fetch. Pure, network-free, fixture-tested. Every term appends
 * to evidence[] — "why did you scrape /campaign/eid-2026?" must be
 * answerable from the payload, not from log archaeology.
 *
 *   score = clamp01(0.60·keyword + 0.40·sourcePrior + bonuses − penalties)
 */

export interface RawCandidate {
  url: string; // absolute, not yet canonicalized
  source: CandidateSource;
  /** The merchant's OWN label for the link — trusted most (×1.0). */
  anchorText?: string | null;
  /** title / aria-label / img[alt] — banner links are images (×0.7). */
  titleText?: string | null;
  /** sitemap <lastmod>, epoch ms */
  lastmodMs?: number | null;
  /** link seen in BOTH nav and footer → a real site section (+0.10) */
  inNavAndFooter?: boolean;
}

export interface ScoreContext {
  now?: Date; // injected for deterministic seasonal tests
}

export interface ScoredCandidate extends RawCandidate {
  score: number; // 0..1; 0 == hard reject
  evidence: string[];
  rejectReason: string | null;
}

/** How much we trust the place the link was found. */
const SOURCE_PRIOR: Record<CandidateSource, number> = {
  root: 0.65, // the homepage IS the sale page on many storefronts
  nav: 1.0,
  hero: 0.9,
  platform: 0.8,
  probe: 0.7,
  body: 0.6,
  sitemap: 0.55,
  footer: 0.5,
  expanded: 0.45,
  network: 0.9, // a campaign endpoint seen on the wire is near-certain
  memo: 0.7, // verified in a previous run
  user: 1.0, // a human pin outranks every machine signal
};

const FRESH_LASTMOD_MS = 14 * 24 * 3600_000;

/** Product-detail-page shapes: /p/, /product/, /dp/, trailing -12345,
 *  .html with a SKU-ish tail. A deal HUB never looks like one of these. */
const PDP_PATH_RE = /\/(p|product|products|dp|item|sku)\/[\w-]+/i;
const PDP_SKU_TAIL_RE = /-(\d{4,}|[a-z0-9]{8,})(\.html?)?$/i;

function looksLikeProductPage(pathname: string): boolean {
  return PDP_PATH_RE.test(pathname) || PDP_SKU_TAIL_RE.test(pathname);
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function scoreCandidate(c: RawCandidate, ctx: ScoreContext = {}): ScoredCandidate {
  const evidence: string[] = [];
  const now = ctx.now ?? new Date();

  let pathname = '/';
  let queryParamCount = 0;
  try {
    const u = new URL(c.url);
    pathname = u.pathname;
    queryParamCount = [...u.searchParams.keys()].length;
  } catch {
    return { ...c, score: 0, evidence: ['reject:unparseable-url'], rejectReason: 'unparseable-url' };
  }

  // ── Hard rejects first: STOP path segments and NEG tokens. ──
  const stop = stopSegmentInPath(pathname);
  if (stop) {
    evidence.push(`reject:stop-segment "${stop}" in path`);
    return { ...c, score: 0, evidence, rejectReason: `stop-segment:${stop}` };
  }
  const negHit =
    hasNegToken(pathname) ??
    (c.anchorText ? hasNegToken(c.anchorText) : null) ??
    (c.titleText ? hasNegToken(c.titleText) : null);
  if (negHit) {
    evidence.push(`reject:neg-token "${negHit}"`);
    return { ...c, score: 0, evidence, rejectReason: `neg-token:${negHit}` };
  }

  // ── 1. Keyword: max over anchor ×1.0, path ×0.85, title ×0.7. ──
  // Anchor text is the merchant's OWN label for the page — trust it most.
  let keyword = 0;
  const anchorKw = c.anchorText ? keywordScore(c.anchorText, now) : null;
  const pathKw = keywordScore(pathname, now);
  const titleKw = c.titleText ? keywordScore(c.titleText, now) : null;
  const fields: Array<[number, number, string, string[]]> = [
    [anchorKw?.weight ?? 0, 1.0, 'anchor', anchorKw?.evidence ?? []],
    [pathKw.weight, 0.85, 'path', pathKw.evidence],
    [titleKw?.weight ?? 0, 0.7, 'title', titleKw?.evidence ?? []],
  ];
  for (const [w, mult, label, ev] of fields) {
    const weighted = w * mult;
    if (w > 0 && weighted >= keyword) {
      keyword = weighted;
      evidence.push(...ev.map((e) => `${label}:${e}`));
    }
  }

  // ── 2. Source prior. ──
  const sourcePrior = SOURCE_PRIOR[c.source];
  evidence.push(`source:${c.source}=${sourcePrior.toFixed(2)}`);

  // ── 3. Bonuses. ──
  let bonus = 0;
  if (c.lastmodMs != null && now.getTime() - c.lastmodMs < FRESH_LASTMOD_MS) {
    bonus += 0.1;
    evidence.push('bonus:lastmod<14d +0.10');
  }
  if (c.inNavAndFooter) {
    bonus += 0.1;
    evidence.push('bonus:nav+footer +0.10');
  }
  const depth = pathname.split('/').filter(Boolean).length;
  if (depth === 1) {
    bonus += 0.05;
    evidence.push('bonus:depth-1 +0.05');
  }

  // ── 4. Penalties. ──
  let penalty = 0;
  if (depth > 3) {
    penalty += 0.3;
    evidence.push(`penalty:depth-${depth} -0.30`);
  }
  if (looksLikeProductPage(pathname)) {
    penalty += 0.4;
    evidence.push('penalty:product-detail-page -0.40');
  }
  if (queryParamCount >= 3) {
    penalty += 0.25;
    evidence.push(`penalty:${queryParamCount}-query-params -0.25`);
  }

  const score = clamp01(0.6 * keyword + 0.4 * sourcePrior + bonus - penalty);
  return { ...c, score, evidence, rejectReason: null };
}
