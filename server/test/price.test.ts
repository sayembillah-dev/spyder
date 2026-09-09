import { describe, expect, it } from 'vitest';
import {
  computeDiscount,
  detectCurrency,
  extractAmounts,
  normalizeDigits,
  parsePrice,
} from '../src/utils/price';
import { amountsFromPriceText } from '../src/services/extractor';

describe('normalizeDigits', () => {
  it('converts Bangla digits to ASCII', () => {
    expect(normalizeDigits('১২৩৪৫৬৭৮৯০')).toBe('1234567890');
    expect(normalizeDigits('৳১,২৯৯')).toBe('৳1,299');
  });
});

describe('extractAmounts', () => {
  it('parses thousands separators and decimals', () => {
    expect(extractAmounts('৳1,250.00')).toEqual([1250]);
    expect(extractAmounts('Tk 99')).toEqual([99]);
  });

  it('parses ranges into both tiers', () => {
    expect(extractAmounts('1,299 - 1,599')).toEqual([1299, 1599]);
  });

  it('ignores percentage tokens so discounts never leak into prices', () => {
    expect(extractAmounts('25%')).toEqual([]);
    expect(extractAmounts('-50% ৳450')).toEqual([450]);
  });

  it('handles Bangla digits', () => {
    expect(extractAmounts('৳১,২৯৯')).toEqual([1299]);
  });
});

describe('parsePrice', () => {
  it('passes through positive numbers', () => {
    expect(parsePrice(1250)).toBe(1250);
    expect(parsePrice(0)).toBeNull();
    expect(parsePrice(-5)).toBeNull();
    expect(parsePrice(NaN)).toBeNull();
  });

  it('takes the lowest tier of a range', () => {
    expect(parsePrice('1,299 - 1,599')).toBe(1299);
  });

  it('returns null for non-price input', () => {
    expect(parsePrice('no price')).toBeNull();
    expect(parsePrice(null)).toBeNull();
    expect(parsePrice(undefined)).toBeNull();
    expect(parsePrice({})).toBeNull();
  });
});

describe('amountsFromPriceText — the universal price invariant', () => {
  it('rejects model numbers embedded in prose ("Hoco EQ27")', () => {
    expect(amountsFromPriceText('Hoco EQ27')).toEqual([]);
  });

  it('rejects sold counters ("176 Sold")', () => {
    expect(amountsFromPriceText('176 Sold')).toEqual([]);
  });

  it('accepts suffix-currency form ("1,299 Tk")', () => {
    expect(amountsFromPriceText('1,299 Tk')).toEqual([1299]);
  });

  it('accepts Bangla digits ("৳১,২৯৯")', () => {
    expect(amountsFromPriceText('৳১,২৯৯')).toEqual([1299]);
  });

  it('accepts purely-numeric bare text (symbol lives in a sibling)', () => {
    expect(amountsFromPriceText('2,150')).toEqual([2150]);
    expect(amountsFromPriceText('  42,500 ')).toEqual([42500]);
  });

  // The raw function DOES surface the EMI figure — it is currency-anchored
  // text. The exclusion lives one level up: pickPrices skips elements whose
  // class/id hints emi/install, and strips such blocks before the whole-card
  // fallback. Locked end-to-end in extractor.test.ts (othoba-hydrated).
  it('surfaces anchored EMI figures (exclusion happens in pickPrices)', () => {
    expect(amountsFromPriceText('৳176/month')).toEqual([176]);
  });

  it('rejects prose that merely contains digits', () => {
    expect(amountsFromPriceText('20mm thick')).toEqual([]);
    expect(amountsFromPriceText('12 Pcs combo pack')).toEqual([]);
    expect(amountsFromPriceText('rated 4.5 by users')).toEqual([]);
  });
});

describe('detectCurrency', () => {
  it('detects the major symbols and codes', () => {
    expect(detectCurrency('৳1,250')).toBe('BDT');
    expect(detectCurrency('Tk 99')).toBe('BDT');
    expect(detectCurrency('BDT 250')).toBe('BDT');
    expect(detectCurrency('$29.99')).toBe('USD');
    expect(detectCurrency('USD 29.99')).toBe('USD');
    expect(detectCurrency('€10')).toBe('EUR');
    expect(detectCurrency('£10')).toBe('GBP');
    expect(detectCurrency('₹499')).toBe('INR');
  });

  it('defaults unknown input to BDT (target market)', () => {
    expect(detectCurrency('1,250')).toBe('BDT');
    expect(detectCurrency('')).toBe('BDT');
    expect(detectCurrency(1250)).toBe('BDT');
  });
});

describe('computeDiscount', () => {
  it('computes whole percentages', () => {
    expect(computeDiscount(100, 80)).toBe(20);
    expect(computeDiscount(110, 95)).toBe(14);
  });

  it('returns null when the "original" is not above the deal', () => {
    expect(computeDiscount(null, 80)).toBeNull();
    expect(computeDiscount(80, 100)).toBeNull();
    expect(computeDiscount(80, 80)).toBeNull();
  });
});
