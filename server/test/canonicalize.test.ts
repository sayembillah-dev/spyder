import { describe, expect, it } from 'vitest';
import { canonicalizeUrl } from '../src/discovery/canonicalize';

const BASE = 'https://shop.example.com';

describe('canonicalizeUrl', () => {
  it('strips tracking params and keeps meaningful ones', () => {
    expect(
      canonicalizeUrl('/deals?utm_source=fb&fbclid=abc&gclid=x&page=2', BASE),
    ).toBe(`${BASE}/deals?page=2`);
  });

  it('drops params that do not change the product set', () => {
    expect(canonicalizeUrl('/deals?color=red&size=m', BASE)).toBe(`${BASE}/deals`);
    expect(canonicalizeUrl('/deals?on_sale=1', BASE)).toBe(`${BASE}/deals?on_sale=1`);
  });

  it('sorts kept params so permutations dedupe', () => {
    const a = canonicalizeUrl('/deals?page=2&sort=price', BASE);
    const b = canonicalizeUrl('/deals?sort=price&page=2', BASE);
    expect(a).toBe(b);
  });

  it('drops the fragment, collapses slashes, normalizes trailing slash', () => {
    expect(canonicalizeUrl('/deals#today', BASE)).toBe(`${BASE}/deals`);
    expect(canonicalizeUrl('/deals//flash', BASE)).toBe(`${BASE}/deals/flash`);
    expect(canonicalizeUrl('/deals/', BASE)).toBe(`${BASE}/deals`);
    expect(canonicalizeUrl('/', BASE)).toBe(`${BASE}/`);
  });

  it('lowercases host and strips default ports', () => {
    expect(canonicalizeUrl('HTTPS://SHOP.Example.COM:443/deals', BASE)).toBe(`${BASE}/deals`);
    expect(canonicalizeUrl('http://SHOP.example.com:80/deals', BASE)).toBe(
      'http://shop.example.com/deals',
    );
  });

  it('resolves relative URLs against the base', () => {
    expect(canonicalizeUrl('../deals', `${BASE}/category/shoes`)).toBe(`${BASE}/deals`);
  });

  it('rejects non-http(s) schemes and garbage', () => {
    expect(canonicalizeUrl('javascript:void(0)', BASE)).toBeNull();
    expect(canonicalizeUrl('mailto:a@b.c', BASE)).toBeNull();
    expect(canonicalizeUrl('http://', BASE)).toBeNull();
    // NB: 'garbage text' resolves as a relative PATH against the base —
    // that is correct for harvested hrefs, which are routinely relative.
  });

  it('rejects absurd depth and length', () => {
    const deep = '/' + Array.from({ length: 8 }, (_, i) => `s${i}`).join('/');
    expect(canonicalizeUrl(deep, BASE)).toBeNull();
    expect(canonicalizeUrl(`/deals?q=${'x'.repeat(600)}`, BASE)).toBeNull();
  });
});
