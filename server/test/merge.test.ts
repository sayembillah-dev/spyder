import { describe, expect, it } from 'vitest';
import { ProductMerger, productKey } from '../src/utils/merge';
import type { ScrapedProduct } from '../src/types';

let seq = 0;
function mk(over: Partial<ScrapedProduct> = {}): ScrapedProduct {
  seq += 1;
  return {
    id: `p${seq}`,
    title: `Product ${seq}`,
    originalPrice: null,
    dealPrice: 100,
    discountPercentage: null,
    currency: 'BDT',
    sourceSite: 'SiteA',
    productUrl: `https://a.test/p${seq}`,
    imageUrl: null,
    ...over,
  };
}

describe('productKey', () => {
  it('is title(lower) + deal price — same listing reached twice collapses', () => {
    const a = mk({ title: 'Sony XM5', dealPrice: 100 });
    const b = mk({ title: 'sony xm5', dealPrice: 100 });
    expect(productKey(a)).toBe(productKey(b));
  });

  it('distinguishes different SKUs that merely share a price', () => {
    expect(productKey(mk({ title: 'A', dealPrice: 100 }))).not.toBe(
      productKey(mk({ title: 'B', dealPrice: 100 })),
    );
  });
});

describe('ProductMerger', () => {
  it('dedupes identical listings across strategies', () => {
    const m = new ProductMerger(10);
    m.add([mk({ title: 'Sony XM5', dealPrice: 100 })], 'https://a.test/');
    const added = m.add([mk({ title: 'sony xm5', dealPrice: 100 })], 'https://a.test/');
    expect(added).toBe(0);
    expect(m.size).toBe(1);
  });

  it('backfills a missing image on the incumbent', () => {
    const m = new ProductMerger(10);
    m.add([mk({ title: 'T', dealPrice: 100, imageUrl: null })], 'https://a.test/');
    m.add([mk({ title: 'T', dealPrice: 100, imageUrl: 'https://img.test/t.jpg' })], 'https://a.test/');
    expect(m.values()[0]!.imageUrl).toBe('https://img.test/t.jpg');
  });

  it('backfills originalPrice (and discount) when the repeat is a real strike-through', () => {
    const m = new ProductMerger(10);
    m.add([mk({ title: 'T', dealPrice: 100 })], 'https://a.test/');
    m.add(
      [mk({ title: 'T', dealPrice: 100, originalPrice: 150, discountPercentage: 33 })],
      'https://a.test/',
    );
    expect(m.values()[0]!.originalPrice).toBe(150);
    expect(m.values()[0]!.discountPercentage).toBe(33);
  });

  it('rejects "original" prices at or below the deal price', () => {
    const m = new ProductMerger(10);
    m.add([mk({ title: 'T', dealPrice: 100 })], 'https://a.test/');
    m.add([mk({ title: 'T', dealPrice: 100, originalPrice: 90 })], 'https://a.test/');
    expect(m.values()[0]!.originalPrice).toBeNull();
  });

  it('upgrades a page-level fallback link to a real product link, even across pages', () => {
    const m = new ProductMerger(10);
    const page1 = 'https://a.test/deals';
    const page2 = 'https://a.test/deals?page=2';
    // first sighting: card had no anchor → fallback is the page URL
    m.add([mk({ title: 'T', dealPrice: 100, productUrl: page1 })], page1);
    // second sighting on page 2: now with a real link
    m.add([mk({ title: 'T', dealPrice: 100, productUrl: 'https://a.test/item/7' })], page2);
    expect(m.values()[0]!.productUrl).toBe('https://a.test/item/7');
  });

  it('never replaces a real link with a page-level fallback', () => {
    const m = new ProductMerger(10);
    const page2 = 'https://a.test/deals?page=2';
    m.add([mk({ title: 'T', dealPrice: 100, productUrl: 'https://a.test/item/7' })], 'https://a.test/deals');
    m.add([mk({ title: 'T', dealPrice: 100, productUrl: page2 })], page2);
    expect(m.values()[0]!.productUrl).toBe('https://a.test/item/7');
  });

  it('stops admitting new products at the cap but keeps enriching existing ones', () => {
    const m = new ProductMerger(2);
    m.add([mk({ title: 'A', dealPrice: 1 }), mk({ title: 'B', dealPrice: 2 })], 'https://a.test/');
    const added = m.add(
      [mk({ title: 'C', dealPrice: 3 }), mk({ title: 'A', dealPrice: 1, imageUrl: 'https://img.test/a.jpg' })],
      'https://a.test/',
    );
    expect(added).toBe(0);
    expect(m.size).toBe(2);
    expect(m.values().find((p) => p.title === 'A')!.imageUrl).toBe('https://img.test/a.jpg');
  });
});
