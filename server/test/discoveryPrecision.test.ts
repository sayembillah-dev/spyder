import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * Definition-of-done audit: **precision@5 ≥ 0.8 on the fixture set, zero
 * network access** (D2 acceptance, restated in the plan's DoD).
 *
 * The corpus is three platforms (Shopify / WooCommerce / a Bangla
 * marketplace), each mixing true deal pages with realistic junk: product
 * detail links, STOP paths, off-site links, and — the real pressure —
 * category pages whose names SOUND like deals ('Offers', 'All Products')
 * but carry zero discounts. A scoring regression lets junk into the top-5;
 * a verification regression lets a zero-discount catalog page pose as a
 * deal page. Either failure drags corpus precision below 0.8.
 *
 * Ground truth is the route table: a URL is a deal page iff we served it
 * the deal-page fixture.
 */
vi.mock('../src/utils/ssrf', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/utils/ssrf')>();
  return { ...mod, assertPublicUrl: async (url: string) => new URL(url) };
});
vi.mock('../src/utils/robots', () => ({
  sitemapsFromRobots: async () => [] as string[],
  allowedByRobots: async () => true,
}));

import { discoverDealPages } from '../src/discovery';

const fx = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', 'discovery', name), 'utf8');

const DEALS = fx('deal-page.html'); // 12/12 discounted → accepts
/** Distinct product sets so fingerprint dedupe can't collapse them
 *  (9/15 Jaccard = 0.6 vs DEALS; 6/18 = 0.33 between B and C). */
const DEALS_B = DEALS.replace('Wireless Earbuds Pro', 'Gadget Alpha')
  .replace('Smart Watch X2', 'Gadget Beta')
  .replace('Bluetooth Speaker Mini', 'Gadget Gamma');
const DEALS_C = DEALS.replace('Power Bank 20000mAh', 'Gadget Delta')
  .replace('Braided USB-C Cable', 'Gadget Epsilon')
  .replace('Shockproof Phone Case', 'Gadget Zeta');

/** A full category page with its ONE discounted item's strike-through
 *  removed: 8 products, 0 discounts → density 0 → 'no-discounts' hard
 *  reject. The distractor that must NEVER be selected. */
const NODISC = fx('category-page.html').replace(
  /<span class="original-price[^"]*">[^<]*<\/span>/,
  '',
);
expect(NODISC).not.toContain('original-price'); // the strip really happened

function fakeWeb(routes: Record<string, string>) {
  const fetchFn = async (url: string): Promise<string> => {
    const body = routes[url];
    if (body !== undefined) return body;
    const err = new Error('Request failed with status code 404');
    err.name = 'FetchHttpError';
    throw err;
  };
  return { fetchFn };
}

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

const pathOf = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

interface Site {
  domain: string;
  routes: Record<string, string>;
  /** pathname+search of every true deal page (ground truth). */
  dealPaths: Set<string>;
}

const CORPUS: Site[] = [
  {
    domain: 'shopify-precision.com',
    routes: {
      'https://shopify-precision.com/': fx('shopify-home.html'),
      'https://shopify-precision.com/collections/sale': DEALS,
      'https://shopify-precision.com/collections/clearance': DEALS_B,
      'https://shopify-precision.com/collections/all': NODISC,
      'https://shopify-precision.com/collections/new-arrivals': NODISC,
    },
    dealPaths: new Set(['/collections/sale', '/collections/clearance']),
  },
  {
    domain: 'woo-precision.com',
    routes: {
      'https://woo-precision.com/': fx('woocommerce-home.html'),
      // canonicalization strips trailing slashes — keys are the canonical form
      'https://woo-precision.com/product-category/sale': DEALS,
      'https://woo-precision.com/shop?on_sale=1': DEALS_B,
      'https://woo-precision.com/shop': NODISC,
      'https://woo-precision.com/product-category/electronics': NODISC,
    },
    dealPaths: new Set(['/product-category/sale', '/shop?on_sale=1']),
  },
  {
    domain: 'bd-precision.com',
    routes: {
      'https://bd-precision.com/': fx('bd-marketplace-home.html'),
      'https://bd-precision.com/campaign/eid-2026': DEALS,
      'https://bd-precision.com/flash-sale': DEALS_B,
      'https://bd-precision.com/campaign/mega-sale': DEALS_C,
      // sounds like deals, is a zero-discount catalog — the precision trap
      'https://bd-precision.com/offers': NODISC,
      'https://bd-precision.com/categories': NODISC,
    },
    dealPaths: new Set(['/campaign/eid-2026', '/flash-sale', '/campaign/mega-sale']),
  },
];

describe('Definition of done — precision@5 over the fixture corpus (network-free)', () => {
  it('corpus precision@5 ≥ 0.8, with full recall of the true deal pages', async () => {
    let precisionSum = 0;
    const perSite: string[] = [];

    for (const site of CORPUS) {
      const { fetchFn } = fakeWeb(site.routes);
      const { report, selected } = await discoverDealPages(site.domain, {
        ...HOOKS,
        fetchFn,
      });

      // RECALL — every true deal page must be found, or the precision
      // number is meaningless (a system that selects nothing scores 1.0).
      const selectedPaths = new Set(selected.map((c) => pathOf(c.url)));
      for (const p of site.dealPaths) {
        expect(selectedPaths, `${site.domain} missed deal page ${p}`).toContain(p);
      }

      // PRECISION@5 — of the top-5 ranked selections, how many are true
      // deal pages. Demoted/fallback entries count AGAINST precision: they
      // are presented to the user, so they must earn their place.
      const ranked = [...selected].sort(
        (a, b) => (b.finalScore ?? b.priorScore) - (a.finalScore ?? a.priorScore),
      );
      const top5 = ranked.slice(0, 5);
      const hits = top5.filter((c) => site.dealPaths.has(pathOf(c.url))).length;
      const precision = hits / Math.max(1, top5.length);
      precisionSum += precision;
      perSite.push(`${site.domain}: ${hits}/${top5.length} = ${precision.toFixed(2)}`);

      // The trap: a deal-NAMED zero-discount page is explained, never selected.
      for (const c of selected) {
        expect(site.dealPaths.has(pathOf(c.url)), `${site.domain} selected junk ${c.url}`).toBe(
          true,
        );
      }
      // …and at least one such trap was actually sprung and explained.
      expect(
        report.rejected.some((r) => r.verified?.rejectedReason === 'no-discounts'),
        `${site.domain} never verified a zero-discount trap — corpus too soft`,
      ).toBe(true);
    }

    console.log('precision@5 per site →', perSite.join(' | '));
    expect(precisionSum / CORPUS.length).toBeGreaterThanOrEqual(0.8);
  }, 30_000);
});
