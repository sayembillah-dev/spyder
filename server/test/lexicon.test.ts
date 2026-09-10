import { describe, expect, it } from 'vitest';
import { hasNegToken, keywordScore, stopSegmentInPath, tokenize } from '../src/discovery/lexicon';

/** D2.1/D2.2 — tokenization and the weighted lexicon. Network-free. */
describe('tokenize', () => {
  it('splits on non-alphanumerics and camelCase', () => {
    expect(tokenize('/wholesale-buyers')).toEqual(['wholesale', 'buyers']);
    expect(tokenize('/flashSale')).toEqual(['flash', 'sale']);
    expect(tokenize('Flash-Sale_NOW!!')).toEqual(['flash', 'sale', 'now']);
  });

  it('keeps Bangla as word characters', () => {
    expect(tokenize('ফ্ল্যাশ সেল')).toEqual(['ফ্ল্যাশ', 'সেল']);
    expect(tokenize('/offer-অফার')).toEqual(['offer', 'অফার']);
  });
});

describe('keywordScore', () => {
  it('matches tier-A unigrams at full weight', () => {
    expect(keywordScore('/flash-sale').weight).toBe(1);
    expect(keywordScore('Deals').weight).toBe(1);
    expect(keywordScore('/clearance').weight).toBe(1);
  });

  it('matches bigrams and prefers the strongest phrase', () => {
    const { weight, evidence } = keywordScore('Hot Deals Today');
    expect(weight).toBe(1);
    expect(evidence.some((e) => e.includes('hot deals'))).toBe(true);
  });

  it('matches Bangla tokens', () => {
    expect(keywordScore('অফার').weight).toBe(1);
    expect(keywordScore('ফ্ল্যাশ সেল').weight).toBe(1);
    expect(keywordScore('ক্যাম্পেইন').weight).toBeCloseTo(0.9);
  });

  it('never matches "sale" inside other words (token boundaries)', () => {
    expect(keywordScore('/wholesale-buyers').weight).toBe(0);
    expect(keywordScore('/salem-store-locator').weight).toBe(0);
  });

  it('handles merchant misspellings via bounded edit distance', () => {
    expect(keywordScore('/clearence').weight).toBe(1);
    expect(keywordScore('/discout').weight).toBe(1);
  });

  it('never fuzzy-matches short tokens (sale/sold/sole)', () => {
    expect(keywordScore('/sold-items').weight).toBe(0);
    expect(keywordScore('/sole').weight).toBe(0);
  });

  it('boosts seasonal tokens in season and damps them out of season', () => {
    const november = new Date('2026-11-15T00:00:00Z');
    const march = new Date('2026-03-15T00:00:00Z');
    expect(keywordScore('Black Friday', november).weight).toBeCloseTo(1.0);
    expect(keywordScore('Black Friday', march).weight).toBeCloseTo(0.45);
  });

  it('scores weak tier-C tokens below campaign tokens', () => {
    expect(keywordScore('/save').weight).toBeCloseTo(0.45);
    expect(keywordScore('/combo').weight).toBeCloseTo(0.45);
  });
});

describe('hasNegToken / stopSegmentInPath', () => {
  it('flags explicit reject tokens', () => {
    expect(hasNegToken('/wholesale')).toBe('wholesale');
    expect(hasNegToken('Wholesale Buyers Club')).toBe('wholesale');
    expect(hasNegToken('/deals')).toBeNull();
  });

  it('flags stop path segments, whole segments only', () => {
    expect(stopSegmentInPath('/blog/top-10-deals')).toBe('blog');
    expect(stopSegmentInPath('/cart')).toBe('cart');
    expect(stopSegmentInPath('/flash-sale')).toBeNull();
    // 'blogger' contains 'blog' but is not the segment 'blog'
    expect(stopSegmentInPath('/blogger-sale')).toBeNull();
  });
});
