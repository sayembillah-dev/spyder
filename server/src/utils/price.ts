import { createHash } from 'node:crypto';

const BANGLA_DIGITS: Record<string, string> = {
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9',
};

export function normalizeDigits(input: string): string {
  return input.replace(/[০-৯]/g, (d) => BANGLA_DIGITS[d] ?? d);
}

/**
 * Extract every numeric amount from a string.
 * Handles "৳1,250.00", "Tk 99", "1,299 - 1,599" and Bangla digits.
 * Percentage tokens ("25%") are ignored so discounts never leak into prices.
 */
export function extractAmounts(raw: string): number[] {
  const s = normalizeDigits(raw).replace(/\d+(?:\.\d+)?\s*%/g, ' ');
  const matches = s.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) ?? [];
  return matches
    .map((m) => parseFloat(m.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** Parse a single price field ("৳1,250", "Tk 99.50", 1250) into a float. */
export function parsePrice(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const amounts = extractAmounts(raw);
  return amounts.length ? Math.min(...amounts) : null; // price ranges → lowest tier
}

export function detectCurrency(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  if (s.includes('৳') || /Tk\.?|BDT|টাকা/i.test(s)) return 'BDT';
  if (s.includes('$') || /USD/i.test(s)) return 'USD';
  if (s.includes('€') || /EUR/i.test(s)) return 'EUR';
  if (s.includes('£') || /GBP/i.test(s)) return 'GBP';
  if (s.includes('₹') || /INR/i.test(s)) return 'INR';
  return 'BDT'; // default for the target market
}

export function computeDiscount(original: number | null, deal: number): number | null {
  if (!original || original <= deal) return null;
  return Math.round(((original - deal) / original) * 100);
}

export function makeId(...parts: string[]): string {
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}
