const CURRENCY_SYMBOLS: Record<string, string> = {
  BDT: '৳',
  USD: '$',
  EUR: '€',
  GBP: '£',
  INR: '₹',
};

export function fmtPrice(n: number, currency: string = 'BDT'): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  return `${symbol}${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

const BADGE_PALETTE = [
  'bg-rose-500/15 text-rose-300 border-rose-500/30',
  'bg-sky-500/15 text-sky-300 border-sky-500/30',
  'bg-amber-500/15 text-amber-300 border-amber-500/30',
  'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  'bg-violet-500/15 text-violet-300 border-violet-500/30',
  'bg-pink-500/15 text-pink-300 border-pink-500/30',
  'bg-lime-500/15 text-lime-300 border-lime-500/30',
  'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
];

/** Deterministic color per store name. */
export function siteBadgeClass(site: string): string {
  let h = 0;
  for (const ch of site) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BADGE_PALETTE[h % BADGE_PALETTE.length]!;
}
