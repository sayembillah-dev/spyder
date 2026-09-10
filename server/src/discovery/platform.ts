/**
 * D3 Tier 3 — platform fingerprint + probe packs.
 *
 * Platform-specific ≠ site-specific: a probe pack keys off a DETECTED
 * e-commerce platform (a fingerprint in the HTML), never a hostname, and so
 * applies to millions of unseen sites. This is the escape valve that keeps
 * the system both general and sharp.
 *
 * fingerprintPlatform is pure; probing policy (skip-already-found, soft-404
 * rejection, negativePaths) lives in the tier orchestrator.
 */

export type Platform =
  | 'shopify'
  | 'woocommerce'
  | 'magento'
  | 'bigcommerce'
  | 'nextjs'
  | 'wix'
  | 'squarespace'
  | 'opencart'
  | 'prestashop';

interface Fingerprint {
  platform: Platform;
  patterns: RegExp[];
}

/** Ordered: first match wins. Patterns are deliberately the STRONGEST
 *  single tells (cdn URLs, generator meta, platform JS globals). */
const FINGERPRINTS: Fingerprint[] = [
  { platform: 'shopify', patterns: [/cdn\.shopify\.com/i, /Shopify\.theme/i, /myshopify\.com/i] },
  {
    platform: 'woocommerce',
    patterns: [/\/wp-content\/plugins\/woocommerce/i, /woocommerce(?:-|_)(?:ajax|js|css)/i],
  },
  { platform: 'magento', patterns: [/Mage\.Cookies/i, /\/static\/frontend\/Magento/i, /mage\/cookies/i] },
  { platform: 'bigcommerce', patterns: [/bigcommerce\.com\/s-/i, /cdn\d*\.bigcommerce\.com/i] },
  { platform: 'prestashop', patterns: [/content\/themes\/[^"']*prestashop/i, /PrestaShop/i] },
  { platform: 'opencart', patterns: [/catalog\/view\/theme/i, /route=common\/home/i] },
  { platform: 'wix', patterns: [/wixstatic\.com/i, /X-Wix-Request-Id/i] },
  { platform: 'squarespace', patterns: [/squarespace-cdn\.com/i, /static\.squarespace\.com/i] },
  { platform: 'nextjs', patterns: [/__NEXT_DATA__/i, /\/_next\/static\//i] },
];

/** <meta name="generator" content="..."> is the most honest fingerprint a
 *  site offers — check it first, then fall back to markup tells. */
const GENERATOR_RE = /<meta\s+[^>]*name=["']generator["'][^>]*content=["']([^"']+)["']/i;

export function fingerprintPlatform(html: string): Platform | null {
  const gen = GENERATOR_RE.exec(html)?.[1]?.toLowerCase() ?? '';
  if (gen.includes('shopify')) return 'shopify';
  if (gen.includes('woocommerce') || gen.includes('wordpress')) return 'woocommerce';
  if (gen.includes('magento')) return 'magento';
  if (gen.includes('bigcommerce')) return 'bigcommerce';
  if (gen.includes('prestashop')) return 'prestashop';
  if (gen.includes('opencart')) return 'opencart';
  if (gen.includes('wix')) return 'wix';
  if (gen.includes('squarespace')) return 'squarespace';

  // Sample, don't scan 5 MB of HTML with 20 regexes.
  const sample = html.slice(0, 500_000);
  for (const fp of FINGERPRINTS) {
    if (fp.patterns.some((p) => p.test(sample))) return fp.platform;
  }
  return null;
}

/**
 * Probe paths per platform, in order. Unknown platforms get the
 * conventional-path list — these are guesses, kept cheap by the probe
 * discipline (skip paths already discovered, soft-404 = reject).
 */
export const PROBE_PACKS: Record<Platform | 'unknown', string[]> = {
  shopify: [
    '/collections/sale',
    '/collections/all?filter.v.price.gte=0&sort_by=best-selling',
    '/collections/clearance',
    '/collections/deals',
  ],
  woocommerce: ['/shop/?on_sale=1', '/product-category/sale/', '/sale/', '/offers/'],
  magento: ['/sale.html', '/deals.html', '/promotions'],
  bigcommerce: ['/sale/', '/categories/sale'],
  nextjs: ['/deals', '/offers', '/sale', '/promotions'],
  wix: ['/deals', '/sale', '/offers'],
  squarespace: ['/deals', '/sale', '/offers'],
  opencart: ['/index.php?route=product/special', '/specials'],
  prestashop: ['/prices-drop', '/promotions', '/sales'],
  unknown: [
    '/deals',
    '/offers',
    '/sale',
    '/discount',
    '/promotions',
    '/clearance',
    '/flash-sale',
    '/campaign',
  ],
};

export function probePathsFor(platform: Platform | null): string[] {
  return PROBE_PACKS[platform ?? 'unknown'];
}
