import { fetchHtml } from '../services/detector';
import { extractWithDiagnostics } from '../services/extractor';
import { detectBlock } from '../utils/block';
import { scoreExtraction } from '../utils/quality';
import { config } from '../config';
import type { DealCandidate, RenderType, ScrapedProduct, VerificationResult } from '../types';
import { productFingerprint } from './fingerprint';
import { siteNameFromUrl } from '../utils/sites';

/**
 * D4 — verification: from hypothesis to evidence.
 *
 * A keyword match earns ONE cheap fetch, never a full crawl. Verification is
 * the SSR rung we already have — fetchHtml → extractWithDiagnostics →
 * scoreExtraction. Single page only: NO pagination, NO load-more, NO
 * browser. Cap at 60 products — enough to measure, cheap to get.
 */

const VERIFY_PRODUCT_CAP = config.discovery.verify.productCap;

/** Structural flash-sale tells: countdown markup + urgency copy. Entirely
 *  structural — works on any platform, any language the regex covers. */
const COUNTDOWN_RE =
  /class=["'][^"']*countdown|data-countdown|\[data-timer\]|class=["'][^"']*timer|ends?\s+in|hurry|limited[\s-]time|শেষ\s*হবে|সময়\s*বাকি/i;

export function hasCountdownTells(html: string): boolean {
  return COUNTDOWN_RE.test(html.slice(0, 500_000));
}

/** CSR pages yield 0 products from raw HTML — but a CSR candidate with a
 *  strong prior is NOT rejected (that would repeat the "partial scrape looks
 *  complete" mistake); it is kept unverified at its prior score and the full
 *  ladder below already knows how to render it. */
export const CSR_UNVERIFIED = 'unverified-csr';

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Rough SSR/CSR scoring on HTML we already have — mirrors the detector's
 *  signals without refetching: a shell marker div (__next/root/app) with
 *  almost no visible text is a CSR shell. A real SSR page carrying
 *  id="__next" would have substantial body text, so text volume alone
 *  disambiguates. */
export function detectRenderTypeFromHtml(html: string): RenderType {
  const bodyText = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const shellish =
    /<div\s+id=["'](__next|root|app)["']/i.test(html) || /__NEXT_DATA__|__NUXT__/i.test(html);
  return shellish && bodyText.length < 500 ? 'CSR' : 'SSR';
}

/**
 * The cheap verification pass. rejectedReason set ⇒ the candidate failed.
 * `blocked` is a reject but, per the registry invariants (D6.2), says
 * nothing about the page and never poisons records.
 *
 * Returns the extracted products and the fetched HTML alongside the verdict:
 * the products feed fingerprint dedupe (D4.4), and the HTML is handed to the
 * scraper so a selected page is never fetched twice (efficiency invariant 2).
 */
export interface VerifyOutcome {
  verification: VerificationResult;
  products: ScrapedProduct[];
  /** null when the fetch itself failed — nothing to hand downstream. */
  html: string | null;
}

export async function verifyCandidate(
  c: DealCandidate,
  signal?: AbortSignal,
  preFetchedHtml?: string,
  fetchFn: (url: string, signal?: AbortSignal) => Promise<string> = fetchHtml,
): Promise<VerifyOutcome> {
  const fail = (rejectedReason: string, html?: string): VerifyOutcome => ({
    verification: {
      productCount: 0,
      dealDensity: 0,
      medianDiscountPct: null,
      quality: scoreExtraction([], c.url, html),
      hasCountdown: html ? hasCountdownTells(html) : false,
      renderType: html ? detectRenderTypeFromHtml(html) : 'SSR',
      productFingerprint: '',
      rejectedReason,
    },
    products: [],
    html: html ?? null,
  });

  let html: string;
  if (preFetchedHtml !== undefined) {
    html = preFetchedHtml; // the homepage fetch is reused, never repeated (D5)
  } else {
    try {
      html = await fetchFn(c.url, signal);
    } catch (err) {
      return fail(err instanceof Error && err.name === 'AbortError' ? 'aborted' : 'fetch-failed');
    }
  }

  const blockReason = detectBlock(html);
  if (blockReason) return fail(`blocked:${blockReason}`, html);

  const renderType = detectRenderTypeFromHtml(html);
  const { products } = extractWithDiagnostics(html, c.url, siteNameFromUrl(c.url));
  const capped = products.slice(0, VERIFY_PRODUCT_CAP);

  if (capped.length === 0 && renderType === 'CSR') {
    return { ...fail(CSR_UNVERIFIED, html), products: [], html };
  }

  const withDiscount = capped.filter(
    (p) => p.originalPrice !== null || p.discountPercentage !== null,
  );
  const result: VerificationResult = {
    productCount: capped.length,
    dealDensity: capped.length ? withDiscount.length / capped.length : 0,
    medianDiscountPct: median(
      capped.map((p) => p.discountPercentage).filter((n): n is number => n !== null),
    ),
    quality: scoreExtraction(capped, c.url, html),
    hasCountdown: hasCountdownTells(html),
    renderType,
    productFingerprint: productFingerprint(capped),
  };

  // ── D4.2 accept / reject / demote. Deal density is the single most
  // discriminating signal (sale page 60–95%, category page 2–10%) — but
  // NEVER a hard gate: legitimate flash-sale pages showing only final prices
  // exist, so a strong prior or a countdown can substitute for density. ──
  const v = config.discovery.verify;
  const minProducts = v.minProducts;
  const acceptProducts = v.acceptProducts;
  const escalateBelow = config.quality.escalateBelow;
  const densityAccept = v.densityAccept;
  const densityReject = v.densityReject;
  const strongPrior = v.strongPrior;
  const rejectPriorFloor = v.rejectPriorFloor;

  if (result.productCount < minProducts) {
    result.rejectedReason = 'not-a-listing'; // blog, landing page
  } else if (result.dealDensity < densityReject && c.priorScore < rejectPriorFloor) {
    result.rejectedReason = 'no-discounts';
  } else if (
    !(
      result.productCount >= acceptProducts &&
      result.quality.score >= escalateBelow &&
      (result.dealDensity >= densityAccept || result.hasCountdown || c.priorScore >= strongPrior)
    )
  ) {
    result.rejectedReason = 'demoted'; // kept, ranked below accepted candidates
  }
  return { verification: result, products: capped, html };
}

/** D4.3 — final ranking blend. */
export function finalScore(c: DealCandidate, v: VerificationResult): number {
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  return clamp01(
    0.35 * c.priorScore +
      0.3 * Math.min(1, v.productCount / 40) +
      0.2 * v.dealDensity +
      0.15 * v.quality.score +
      0.05 * (v.hasCountdown ? 1 : 0),
  );
}
