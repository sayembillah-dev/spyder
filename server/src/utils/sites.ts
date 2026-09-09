const KNOWN_SITES: Record<string, string> = {
  'chaldal.com': 'Chaldal',
  'pickaboo.com': 'Pickaboo',
  'daraz.com.bd': 'Daraz',
  'daraz.com': 'Daraz',
  'rokomari.com': 'Rokomari',
  'othoba.com': 'Othoba',
  'priyoshop.com': 'PriyoShop',
  'ajkerdeal.com': 'AjkerDeal',
  'shajgoj.com': 'Shajgoj',
  'evaly.com.bd': 'Evaly',
};

export function siteNameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    // exact match first, then subdomains (pages.daraz.com.bd → Daraz)
    const known = Object.keys(KNOWN_SITES).find((d) => host === d || host.endsWith(`.${d}`));
    if (known) return KNOWN_SITES[known]!;
    const base = host.split('.')[0] ?? host;
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return 'Unknown';
  }
}

/** Accepts "chaldal.com/deals" or full URLs; returns null when invalid. */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname.includes('.')) return null;
    return u.href;
  } catch {
    return null;
  }
}
