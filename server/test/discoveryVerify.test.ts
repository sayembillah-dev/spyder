import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dedupeCandidates, fingerprintOverlap, productFingerprint } from '../src/discovery/fingerprint';
import { detectRenderTypeFromHtml, hasCountdownTells } from '../src/discovery/verify';
import { extractWithDiagnostics } from '../src/services/extractor';
import type { ScrapedProduct } from '../src/types';

const fx = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', 'discovery', name), 'utf8');

const product = (title: string, over: Partial<ScrapedProduct> = {}): ScrapedProduct => ({
  id: title,
  title,
  originalPrice: null,
  dealPrice: 100,
  discountPercentage: null,
  currency: 'BDT',
  sourceSite: 'Test',
  productUrl: `https://x.com/p/${title}`,
  imageUrl: null,
  ...over,
});

/* D4 — verification pieces that are network-free. verifyCandidate itself
 * needs HTTP; everything it is composed of is tested here. */

describe('verification signals from fixtures', () => {
  it('a deal page yields many discounted products + countdown tells', () => {
    const html = fx('deal-page.html');
    const { products } = extractWithDiagnostics(html, 'https://x.com/flash-sale', 'Test');
    expect(products.length).toBeGreaterThanOrEqual(10);
    const density =
      products.filter((p) => p.originalPrice !== null || p.discountPercentage !== null).length /
      products.length;
    expect(density).toBeGreaterThan(0.8); // 85% strike-through → verifies
    expect(hasCountdownTells(html)).toBe(true);
    expect(detectRenderTypeFromHtml(html)).toBe('SSR');
  });

  it('a category page yields products but ~no discounts (density gate)', () => {
    const html = fx('category-page.html');
    const { products } = extractWithDiagnostics(html, 'https://x.com/electronics', 'Test');
    expect(products.length).toBeGreaterThanOrEqual(6);
    const density =
      products.filter((p) => p.originalPrice !== null || p.discountPercentage !== null).length /
      products.length;
    expect(density).toBeLessThan(0.3); // 1 of 8 → 12.5% → below accept bar
    expect(hasCountdownTells(html)).toBe(false);
  });

  it('a blog post says "deals" 30× and extracts zero products', () => {
    const html = fx('blog-post.html');
    const { products } = extractWithDiagnostics(html, 'https://x.com/blog/top-10-deals', 'Test');
    expect(products.length).toBeLessThan(3); // → 'not-a-listing'
  });

  it('an SPA shell detects as CSR (→ unverified-csr, never a hard reject)', () => {
    expect(detectRenderTypeFromHtml(fx('spa-shell-home.html'))).toBe('CSR');
    expect(detectRenderTypeFromHtml(fx('deal-page.html'))).toBe('SSR');
  });
});

describe('productFingerprint + dedupeCandidates', () => {
  const listing = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => product(`${prefix} product ${i}`));

  it('is order-independent and spelling-insensitive', () => {
    const a = [product('Wireless Earbuds Pro'), product('Power Bank 20000mAh')];
    const b = [product('  power bank 20000mah '), product('Wireless  Earbuds Pro')].reverse();
    expect(productFingerprint(a)).toBe(productFingerprint(b));
  });

  it('two URLs with the same top-20 products → one survives, the higher-scored', () => {
    const same = listing('same', 20);
    const deals = { url: 'https://x.com/deals', finalScore: 0.9 };
    const offers = { url: 'https://x.com/offers', finalScore: 0.7 };
    const { kept, dupes } = dedupeCandidates([
      { candidate: offers, products: same },
      { candidate: deals, products: [...same].reverse() },
    ]);
    expect(kept.map((c) => c.url)).toEqual(['https://x.com/deals']);
    expect(dupes).toEqual([{ url: 'https://x.com/offers', duplicateOf: 'https://x.com/deals' }]);
  });

  it('below-threshold overlap keeps both', () => {
    const a = listing('alpha', 20);
    const b = [...listing('alpha', 4), ...listing('beta', 16)]; // ~33% overlap
    expect(fingerprintOverlap(a, b)).toBeLessThan(0.8);
    const { kept } = dedupeCandidates([
      { candidate: { url: 'https://x.com/a', finalScore: 0.9 }, products: a },
      { candidate: { url: 'https://x.com/b', finalScore: 0.8 }, products: b },
    ]);
    expect(kept).toHaveLength(2);
  });

  it('identical listings score 1.0 overlap', () => {
    expect(fingerprintOverlap(listing('x', 20), listing('x', 20))).toBe(1);
  });
});
