/**
 * D1.2 — URL canonicalization + dedupe.
 *
 * Without this the candidate space explodes: faceted nav alone generates
 * thousands of `?color=red&size=m&on_sale=1` permutations of one page.
 * We keep only params that plausibly change the PRODUCT SET, sort them,
 * and normalize everything else so two spellings of one page dedupe to
 * a single candidate.
 */

/** Analytics/attribution noise — always dropped. */
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|msclkid|mc_|ref$|referrer|source|_ga)/i;

/** Params that plausibly change which products a page shows. */
const MEANINGFUL_PARAMS =
  /^(page|p|pageNo|pageNumber|sort|order|q|query|search|filter|on_sale|category|cat|collection|tag|type|brand|discount|min_price|max_price)$/i;

const MAX_URL_LENGTH = 512;
const MAX_PATH_DEPTH = 6;

/**
 * Canonical form of `raw` (resolved against `base`), or null when the URL
 * can never be a deal page (non-http, absurd depth/length).
 *
 * strips utm_* / fbclid / gclid · keeps only MEANINGFUL_PARAMS, sorted ·
 * drops fragment · collapses duplicate slashes · lowercases host ·
 * strips default port · normalizes trailing slash · keeps `?page=2`
 */
export function canonicalizeUrl(raw: string, base: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if (u.port === '80' && u.protocol === 'http:') u.port = '';
  if (u.port === '443' && u.protocol === 'https:') u.port = '';

  // Keep meaningful params only, sorted for a stable dedupe key.
  const kept: Array<[string, string]> = [];
  u.searchParams.forEach((value, key) => {
    if (TRACKING_PARAMS.test(key)) return;
    if (!MEANINGFUL_PARAMS.test(key)) return;
    kept.push([key.toLowerCase(), value]);
  });
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);

  // Collapse duplicate slashes; a lone trailing slash is never meaningful
  // ("/deals/" === "/deals"), but the root "/" itself stays.
  u.pathname = u.pathname.replace(/\/{2,}/g, '/');
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  const depth = u.pathname.split('/').filter(Boolean).length;
  if (depth > MAX_PATH_DEPTH) return null;
  if (u.href.length > MAX_URL_LENGTH) return null;
  return u.href;
}
