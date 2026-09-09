import { describe, expect, it } from 'vitest';
import { parseClaimedTotal, scoreExtraction } from '../src/utils/quality';
import { config } from '../src/config';
import type { ScrapedProduct } from '../src/types';

let seq = 0;
function mk(over: Partial<ScrapedProduct> = {}): ScrapedProduct {
  seq += 1;
  return {
    id: `q${seq}`,
    title: `Product ${seq} With A Real Title`,
    originalPrice: null,
    dealPrice: 100 + seq,
    discountPercentage: null,
    currency: 'BDT',
    sourceSite: 'SiteA',
    productUrl: `https://a.test/item/${seq}`,
    imageUrl: `https://img.test/${seq}.jpg`,
    ...over,
  };
}

describe('parseClaimedTotal', () => {
  it('parses "1,234 products found" phrasing', () => {
    expect(parseClaimedTotal('<p>1,234 products found</p>')).toBe(1234);
    expect(parseClaimedTotal('<span>Showing 24 of 5,678 products</span>')).toBe(5678);
  });
  it('returns null when no claim exists', () => {
    expect(parseClaimedTotal('<p>Hello world</p>')).toBeNull();
  });
});

describe('scoreExtraction', () => {
  it('scores an empty result 0 — always escalates', () => {
    const q = scoreExtraction([], 'https://a.test/');
    expect(q.score).toBe(0);
    expect(q.flags).toContain('empty');
  });

  it('scores a healthy listing high', () => {
    const products = Array.from({ length: 20 }, () =>
      mk({ originalPrice: 500, dealPrice: 400 + seq }),
    );
    const q = scoreExtraction(products, 'https://a.test/');
    expect(q.score).toBeGreaterThan(0.7);
    expect(q.pctWithRealLink).toBe(1);
    expect(q.pctWithImage).toBe(1);
  });

  it('scores plausible-but-wrong garbage below the escalation threshold', () => {
    // sidebar/nav captures: fallback links, no images, identical prices
    const garbage = Array.from({ length: 8 }, () =>
      mk({ productUrl: 'https://a.test/', imageUrl: null, dealPrice: 999 }),
    );
    const q = scoreExtraction(garbage, 'https://a.test/');
    expect(q.score).toBeLessThan(config.quality.escalateBelow);
    expect(q.flags).toContain('all-prices-identical');
    expect(q.flags).toContain('mostly-fallback-links');
  });

  it('flags extreme price variance (mixed cards + banners)', () => {
    const products = [mk({ dealPrice: 10 }), mk({ dealPrice: 20000 }), mk({ dealPrice: 30000 })];
    const q = scoreExtraction(products, 'https://a.test/');
    expect(q.flags).toContain('extreme-variance');
  });

  it('computes coverage against a claimed total', () => {
    const products = Array.from({ length: 12 }, () => mk());
    const html = '<p>1,234 products found</p>';
    const q = scoreExtraction(products, 'https://a.test/', html);
    expect(q.claimedTotal).toBe(1234);
    expect(q.coverage).toBeCloseTo(12 / 1234, 5);
    expect(q.flags).toContain('low-coverage');
    // low coverage drags the score below a no-claim baseline
    const noClaim = scoreExtraction(products, 'https://a.test/');
    expect(q.score).toBeLessThan(noClaim.score);
  });

  it('drops a claimed total that is smaller than the actual count (parse artifact)', () => {
    const products = Array.from({ length: 20 }, () => mk());
    const q = scoreExtraction(products, 'https://a.test/', '<p>3 products</p>');
    expect(q.coverage).toBeNull();
  });

  it('treats a lone product with the page URL as its link as real (OpenGraph pages)', () => {
    const q = scoreExtraction([mk({ productUrl: 'https://a.test/hoodie' })], 'https://a.test/hoodie');
    expect(q.pctWithRealLink).toBe(1);
  });
});
