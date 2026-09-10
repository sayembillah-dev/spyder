/**
 * D1.1 — Same-site guard for discovered URLs.
 *
 * `assertPublicUrl` stops private-network targets; it does NOT stop the new
 * problem discovery introduces: links are read out of remote HTML and then
 * fetched. A compromised or hostile page can point anywhere on the public
 * internet, turning this service into an open proxy / request amplifier.
 * So a discovered URL must live on the same REGISTRABLE DOMAIN (eTLD+1) as
 * the user's input. Subdomains yes (`pages.daraz.com.bd`), anything else no.
 *
 * eTLD+1 without shipping the full Public Suffix List: a compact table of
 * multi-part suffixes covers the cases a shopping crawler actually meets;
 * anything unlisted falls back to last-two-labels, which is correct for the
 * overwhelming majority of gTLDs.
 *
 * Trade-off, stated deliberately: this is a REJECTION filter. Getting it
 * slightly wrong loses a candidate; it never grants access it shouldn't,
 * because the fallback (last two labels) is the STRICTER answer.
 */
const MULTI_PART_SUFFIXES = new Set([
  'com.bd', 'net.bd', 'org.bd',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au',
  'co.in', 'com.pk', 'com.sg', 'com.my', 'com.tr',
  'com.br', 'com.mx', 'com.ar', 'co.jp', 'co.kr', 'co.nz', 'co.za',
  'co.id', 'com.ph', 'com.vn', 'com.np', 'com.lk',
  // …extend from data, not from guesses
]);

/** "pages.daraz.com.bd" → "daraz.com.bd"; "a.b.co.uk" → "b.co.uk";
 *  "localhost" / bare TLDs / IPs → null. */
export function registrableDomain(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h) return null;
  // Literal IPs and single-label hosts have no registrable domain.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return null;
  const labels = h.split('.');
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo)) {
    if (labels.length < 3) return null; // bare "com.bd" is a suffix, not a site
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

/** True when `candidate` lives on the same registrable domain as `root`
 *  (subdomains allowed). Malformed URLs answer false — fail closed. */
export function isSameSite(candidate: string, root: string): boolean {
  try {
    const a = registrableDomain(new URL(candidate).hostname);
    const b = registrableDomain(new URL(root).hostname);
    return a !== null && a === b;
  } catch {
    return false;
  }
}
