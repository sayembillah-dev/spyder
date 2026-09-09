import { describe, expect, it } from 'vitest';
import { buildComparisonGroups } from '../src/services/matcher';
import type { ScrapedProduct } from '../src/types';

let seq = 0;
function mk(
  title: string,
  dealPrice: number,
  sourceSite: string,
  currency = 'BDT',
  originalPrice: number | null = null,
): ScrapedProduct {
  seq += 1;
  return {
    id: `m${seq}`,
    title,
    originalPrice,
    dealPrice,
    discountPercentage: null,
    currency,
    sourceSite,
    productUrl: `https://${sourceSite}.test/i${seq}`,
    imageUrl: null,
  };
}

describe('buildComparisonGroups', () => {
  it('groups the same product across two sites, cheapest first, with savings', () => {
    const groups = buildComparisonGroups([
      mk('Samsung Galaxy A15 (6/128GB)', 18499, 'Pickaboo'),
      mk('Samsung Galaxy A15 6GB 128GB', 19499, 'Daraz'),
      mk('Unrelated Kettle 2L', 1500, 'Daraz'),
    ]);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.items.map((i) => i.sourceSite)).toEqual(['Pickaboo', 'Daraz']);
    expect(g.bestPrice).toBe(18499);
    expect(g.worstPrice).toBe(19499);
    expect(g.savings).toBe(1000);
  });

  it('hard-vetoes conflicting model identities (NA110 is never HD9285)', () => {
    const groups = buildComparisonGroups([
      mk('Philips Air Fryer NA110', 9500, 'SiteA'),
      mk('Philips Air Fryer HD9285', 10500, 'SiteB'),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('hard-vetoes price spreads beyond MAX_PRICE_RATIO (phone vs its case)', () => {
    const groups = buildComparisonGroups([
      mk('Mini Portable USB Rechargeable Fan', 450, 'SiteA'),
      mk('Mini Portable USB Rechargeable Fan', 4900, 'SiteB'),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('hard-vetoes cross-currency groups (currency guard)', () => {
    const groups = buildComparisonGroups([
      mk('Anker PowerCore 20000mAh Power Bank', 2450, 'SiteA', 'BDT'),
      mk('Anker PowerCore 20000mAh Power Bank', 22, 'SiteB', 'USD'),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('allows identical titles across sites when currency matches', () => {
    const groups = buildComparisonGroups([
      mk('Anker PowerCore 20000mAh Power Bank', 2450, 'SiteA', 'BDT'),
      mk('Anker PowerCore 20000mAh Power Bank', 2590, 'SiteB', 'BDT'),
    ]);
    expect(groups).toHaveLength(1);
  });

  it('drops single-site clusters — only cross-site groups are comparisons', () => {
    const groups = buildComparisonGroups([
      mk('Sony WH-1000XM5 Headphones', 32500, 'SiteA'),
      mk('Sony WH-1000XM5 Headphones Black', 33000, 'SiteA'),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('sorts groups by absolute savings, biggest first', () => {
    const groups = buildComparisonGroups([
      mk('Product Alpha Deluxe', 1000, 'SiteA'),
      mk('Product Alpha Deluxe', 1400, 'SiteB'),
      mk('Product Beta Premium', 500, 'SiteA'),
      mk('Product Beta Premium', 700, 'SiteB'),
    ]);
    expect(groups.map((g) => g.savings)).toEqual([400, 200]);
  });

  it('ignores fragments too short to match on', () => {
    const groups = buildComparisonGroups([
      mk('Bag', 100, 'SiteA'),
      mk('Bag', 200, 'SiteB'),
    ]);
    expect(groups).toHaveLength(0);
  });
});
