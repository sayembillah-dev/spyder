import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * D5 — the orchestrator. NETWORK-FREE: the SSRF guard and robots lookup are
 * stubbed at the module boundary, and every page comes from an injected
 * fetch serving fixtures. What is exercised for real: canonicalization,
 * same-site guard, scoring, tier ladder + early exit, verification,
 * fingerprint dedupe, budget enforcement.
 */
vi.mock('../src/utils/ssrf', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/utils/ssrf')>();
  return { ...mod, assertPublicUrl: async (url: string) => new URL(url) };
});
vi.mock('../src/utils/robots', () => ({
  sitemapsFromRobots: async () => [] as string[],
  allowedByRobots: async () => true,
}));

import { discoverDealPages, DiscoveryBudget } from '../src/discovery';

const fx = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', 'discovery', name), 'utf8');

/** A fake web: URL → body. Any other URL 404s (throws like fetchHtml). */
function fakeWeb(routes: Record<string, string>) {
  const calls: string[] = [];
  const fetchFn = async (url: string): Promise<string> => {
    calls.push(url);
    const body = routes[url];
    if (body !== undefined) return body;
    const err = new Error('Request failed with status code 404');
    err.name = 'FetchHttpError';
    throw err;
  };
  return { fetchFn, calls };
}

const HOME = fx('shopify-home.html');
const DEALS = fx('deal-page.html');
const CATEGORY = fx('category-page.html');

/** A second deal page with a DIFFERENT product set — otherwise fingerprint
 *  dedupe (correctly) collapses it into the first. 3 of 12 titles changed →
 *  Jaccard 9/15 = 0.6 < 0.8 → a distinct listing. */
const DEALS_B = DEALS.replace('Wireless Earbuds Pro', 'Gadget Alpha')
  .replace('Smart Watch X2', 'Gadget Beta')
  .replace('Bluetooth Speaker Mini', 'Gadget Gamma');

/** Hermetic hooks: no real registry, no robots network. Without the empty
 *  registry facade, tests in this file would upsert into the REAL store and
 *  later tests would warm-start from them — order-dependent pollution. */
const HOOKS = {
  robotsSitemaps: async () => [] as string[],
  registry: {
    recordsFor: () => [] as never[],
    upsert: () => {},
    recordCheck: () => {},
    isExcluded: () => false,
  },
  memo: () => null,
};

describe('discoverDealPages (network-free, injected fetch)', () => {
  const acmeRoutes = {
    'https://acme-store.com/': HOME,
    'https://acme-store.com/collections/sale': DEALS,
    'https://acme-store.com/collections/clearance': DEALS_B,
    'https://acme-store.com/collections/all': CATEGORY,
    'https://acme-store.com/collections/new-arrivals': CATEGORY,
  };

  it('finds and verifies deal pages from the homepage nav alone', async () => {
    const { fetchFn } = fakeWeb(acmeRoutes);
    const { report, selected } = await discoverDealPages('acme-store.com', {
      ...HOOKS,
      fetchFn,
    });

    expect(report.candidatesFound).toBeGreaterThan(3);
    const paths = selected.map((c) => new URL(c.url).pathname);
    expect(paths).toContain('/collections/sale'); // nav "Sale"
    expect(paths).toContain('/collections/clearance'); // hero banner
    expect(report.platform).toBe('shopify'); // fingerprinted from homepage
    // rejected candidates carry reasons — the debugging surface
    expect(report.rejected.length).toBeGreaterThan(0);
    for (const r of report.rejected) {
      const reason = r.verified?.rejectedReason ?? r.evidence.join(' ');
      expect(reason.length).toBeGreaterThan(0); // every rejection is explained
    }
  });

  it('the same-site guard keeps off-site links out of the frontier', async () => {
    const { fetchFn, calls } = fakeWeb(acmeRoutes);
    await discoverDealPages('acme-store.com', { ...HOOKS, fetchFn });
    // evil-acme.com and twitter.com links exist in the fixture's footer —
    // none may ever be fetched.
    for (const u of calls) {
      expect(u).toMatch(/^https:\/\/([^/]*\.)?acme-store\.com/);
    }
  });

  it('STOP/NEG paths (/blogs/*, /pages/*, /cart) never reach verification', async () => {
    const { fetchFn, calls } = fakeWeb(acmeRoutes);
    await discoverDealPages('acme-store.com', { ...HOOKS, fetchFn });
    expect(calls.some((u) => u.includes('/blogs/'))).toBe(false);
    expect(calls.some((u) => u.includes('/pages/'))).toBe(false);
    expect(calls.some((u) => u.includes('/cart'))).toBe(false);
  });

  it('falls through to sitemaps when the nav has no deal links', async () => {
    const sitemap = fx('sitemap-pages.xml').replaceAll('shop.example.com', 'plain-shop.com');
    const { fetchFn } = fakeWeb({
      'https://plain-shop.com/':
        '<html><head><title>Plain</title></head><body><h1>Hi</h1></body></html>',
      'https://plain-shop.com/sitemap.xml': sitemap,
      'https://plain-shop.com/sitemap_index.xml': sitemap,
      'https://plain-shop.com/deals': DEALS,
      'https://plain-shop.com/offers/weekly': DEALS_B,
      'https://plain-shop.com/flash-sale': DEALS,
    });
    const { report, selected } = await discoverDealPages('plain-shop.com', {
      ...HOOKS,
      fetchFn,
    });
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.some((c) => c.source === 'sitemap')).toBe(true);
    expect(report.candidatesFound).toBeGreaterThan(0);
  });

  it('falls through to platform probes when nav AND sitemaps are empty', async () => {
    const barren =
      '<html><head><title>Barren</title></head><body><a href="/">Home</a></body></html>';
    const { fetchFn } = fakeWeb({
      'https://barren-shop.com/': barren,
      'https://barren-shop.com/deals': DEALS, // probe hit
    });
    const { selected } = await discoverDealPages('barren-shop.com', { ...HOOKS, fetchFn });
    expect(selected.some((c) => c.source === 'probe' && c.url.includes('/deals'))).toBe(true);
  });

  it('hard budget: a 500-candidate site completes within maxFetches and reports budgetExhausted', async () => {
    const urls = Array.from(
      { length: 500 },
      (_, i) => `<url><loc>https://mega-shop.com/deals/cat-${i}</loc></url>`,
    ).join('');
    const bigSitemap = `<?xml version="1.0"?><urlset>${urls}</urlset>`;
    const { fetchFn } = fakeWeb({
      'https://mega-shop.com/': '<html><body><h1>mega</h1></body></html>',
      'https://mega-shop.com/sitemap.xml': bigSitemap,
      'https://mega-shop.com/sitemap_index.xml': bigSitemap,
      'https://mega-shop.com/deals/cat-0': DEALS,
      'https://mega-shop.com/deals/cat-1': DEALS_B,
      'https://mega-shop.com/deals/cat-2': DEALS,
    });
    const { report } = await discoverDealPages('mega-shop.com', {
      ...HOOKS,
      fetchFn,
      // let the frontier keep popping until the BUDGET — not maxVerify —
      // is the binding constraint; that is what this test proves.
      limits: { maxVerify: 500 },
    });
    expect(report.fetchCount).toBeLessThanOrEqual(20); // DISCOVERY_MAX_FETCHES hard cap
    expect(report.budgetExhausted).toBe(true);
  }, 30_000);

  it('the homepage is fetched exactly once (root verification reuses it)', async () => {
    const { fetchFn, calls } = fakeWeb(acmeRoutes);
    await discoverDealPages('acme-store.com', { ...HOOKS, fetchFn });
    expect(calls.filter((u) => u === 'https://acme-store.com/')).toHaveLength(1);
  });

  it('duplicate listings collapse before the scrape, loser recorded', async () => {
    // /deals and /collections/sale serve the SAME products here.
    const { fetchFn } = fakeWeb({
      'https://dup-shop.com/':
        '<html><body><nav><a href="/deals">Deals</a><a href="/collections/sale">Sale</a></nav></body></html>',
      'https://dup-shop.com/deals': DEALS,
      'https://dup-shop.com/collections/sale': DEALS,
    });
    const progress: string[] = [];
    const { selected } = await discoverDealPages('dup-shop.com', {
      ...HOOKS,
      fetchFn,
      onProgress: (m) => progress.push(m),
    });
    expect(selected).toHaveLength(1);
    expect(progress.some((m) => m.includes('duplicates'))).toBe(true);
  });
});

describe('D9 graceful degradation — no dedicated deal page', () => {
  const CATEGORY_DEALS = fx('category-deals-page.html'); // 8 cards, 2 discounted → density 0.25
  /** A distinct product set so fingerprint dedupe can't collapse the two
   *  category pages into one listing. */
  const CATEGORY_DEALS_B = CATEGORY_DEALS.replace('Miniket Rice 5kg', 'Basmati Rice 5kg')
    .replace('Red Lentil 1kg', 'Yellow Lentil 1kg')
    .replace('Soybean Oil 2L', 'Sunflower Oil 2L');

  const navHtml = (links: Array<[string, string]>) =>
    `<!DOCTYPE html><html><head><title>Scattered Deals</title></head><body><nav>${links
      .map(([href, text]) => `<a href="${href}">${text}</a>`)
      .join('')}</nav><main><p>Welcome to our shop.</p></main></body></html>`;

  /** Six deal-keyword nav links that ALL 404, plus real category listings.
   *  The frontier burns maxVerify on the dead deal links first (they
   *  outscore categories), so the categories are still unverified when
   *  selection comes up empty — exactly when D9's ladder should step in. */
  const deadDealLinks: Array<[string, string]> = [
    ['/deals', 'Deals'],
    ['/sale', 'Sale'],
    ['/offers', 'Offers'],
    ['/clearance', 'Clearance'],
    ['/flash-sale', 'Flash Sale'],
    ['/discount-zone', 'Discounts'],
  ];

  it('verifies top category listings when every deal candidate failed', async () => {
    const home = navHtml([
      ...deadDealLinks,
      ['/collections/pantry', 'Pantry Staples'],
      ['/collections/fresh', 'Fresh Food'],
    ]);
    const { fetchFn } = fakeWeb({
      'https://scattered-deals.com/': home,
      'https://scattered-deals.com/collections/pantry': CATEGORY_DEALS,
      'https://scattered-deals.com/collections/fresh': CATEGORY_DEALS_B,
    });
    const progress: string[] = [];
    const { report, selected } = await discoverDealPages('scattered-deals.com', {
      ...HOOKS,
      fetchFn,
      onProgress: (m) => progress.push(m),
    });

    expect(selected).toHaveLength(2);
    for (const c of selected) {
      expect(c.evidence).toContain('fallback:category-listing');
      expect(c.source).toBe('body'); // D9.3: the answer is the listing itself
      expect(c.verified?.dealDensity).toBeGreaterThanOrEqual(0.15);
      expect(c.finalScore).toBeLessThanOrEqual(0.49); // never outranks a real deal page
    }
    // The dead deal links are explained rejects — the debugging surface.
    expect(
      report.rejected.filter((r) => r.verified?.rejectedReason === 'fetch-failed'),
    ).toHaveLength(6);
    // The degradation is reported explicitly (D9 step 3).
    expect(progress.some((m) => m.includes('No dedicated deal page'))).toBe(true);
    expect(progress.some((m) => m.includes('category fallback'))).toBe(true);
    expect(
      progress.some((m) => m.includes('filtered discounted items from 2 category page(s)')),
    ).toBe(true);
  });

  it('marks demoted category selections as the fallback when nothing cleared the accept bar', async () => {
    // No deal keywords at all: the nav IS categories. The frontier verifies
    // them, D4.2 demotes (density 0.25 < 0.30, weak prior), and with zero
    // accepted candidates the whole answer is the fallback.
    const home = navHtml([
      ['/collections/pantry', 'Pantry Staples'],
      ['/collections/fresh', 'Fresh Food'],
    ]);
    const { fetchFn } = fakeWeb({
      'https://quiet-shop.com/': home,
      'https://quiet-shop.com/collections/pantry': CATEGORY_DEALS,
      'https://quiet-shop.com/collections/fresh': CATEGORY_DEALS_B,
    });
    const { selected } = await discoverDealPages('quiet-shop.com', { ...HOOKS, fetchFn });

    expect(selected).toHaveLength(2);
    for (const c of selected) {
      expect(c.verified?.rejectedReason).toBe('demoted');
      expect(c.evidence).toContain('fallback:category-listing');
      expect(c.source).toBe('nav'); // found in the nav — the marker carries the fallback story
    }
  });

  it('deal-sparse category pages stay rejected — an honest empty answer', async () => {
    // Same dead deal links, but the only category page is 12.5% discounted
    // — below the 0.15 fallback bar. Better to say "nothing" than to
    // dress up an ordinary catalog page as deals.
    const home = navHtml([...deadDealLinks, ['/collections/all', 'All Products']]);
    const { fetchFn } = fakeWeb({
      'https://thin-shop.com/': home,
      'https://thin-shop.com/collections/all': CATEGORY, // 8 cards, 1 discounted → 0.125
    });
    const progress: string[] = [];
    const { report, selected } = await discoverDealPages('thin-shop.com', {
      ...HOOKS,
      fetchFn,
      onProgress: (m) => progress.push(m),
    });

    expect(selected).toHaveLength(0);
    expect(report.selected).toHaveLength(0);
    const sparse = report.rejected.find((r) => r.url.includes('/collections/all'));
    expect(sparse?.evidence.join(' ')).toContain('sparse-deals');
  });
});

describe('DiscoveryBudget', () => {
  it('enforces the fetch cap', () => {
    const b = new DiscoveryBudget(3, 60_000);
    expect(b.canFetch()).toBe(true);
    b.spend();
    b.spend();
    expect(b.canFetch()).toBe(true);
    b.spend();
    expect(b.canFetch()).toBe(false);
    expect(b.exhausted).toBe(true);
  });

  it('enforces the duration cap', async () => {
    const b = new DiscoveryBudget(100, 50);
    expect(b.canFetch()).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(b.canFetch()).toBe(false);
  });
});
