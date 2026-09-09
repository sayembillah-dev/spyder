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
    if (KNOWN_SITES[host]) return KNOWN_SITES[host];
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
