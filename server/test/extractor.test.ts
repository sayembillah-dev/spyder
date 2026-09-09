import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { extractProductsFromHtml } from '../src/services/extractor';
import type { ScrapedProduct } from '../src/types';

const FIXTURES = 'test/fixtures';

const stripIds = (ps: ScrapedProduct[]) => ps.map(({ id, ...rest }) => ({ ...rest }));

function runFixture(name: string): ScrapedProduct[] {
  const html = readFileSync(`${FIXTURES}/${name}.html`, 'utf8');
  return extractProductsFromHtml(html, `https://${name}.test/`, name);
}

/* ------------------------------------------------------------------ */
/* Golden fixtures — the regression suite.                            */
/*                                                                    */
/* A snapshot change must be reviewed as a diff, never blind-updated. */
/* To regenerate after a DELIBERATE heuristic change:                 */
/*   npx tsx scripts/regen-snapshots.ts                               */
/* then review the git diff of *.expected.json as if it were code.    */
/* ------------------------------------------------------------------ */

describe('golden fixtures', () => {
  const cases = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.expected.json'))
    .map((f) => f.replace(/\.expected\.json$/, ''));

  it.each(cases)('%s matches its committed snapshot', (name) => {
    const expected = JSON.parse(readFileSync(`${FIXTURES}/${name}.expected.json`, 'utf8'));
    expect(stripIds(runFixture(name))).toEqual(expected);
  });
});

/* ------------------------------------------------------------------ */
/* Targeted locks for the heuristics that have silently broken before */
/* ------------------------------------------------------------------ */

describe('price selection inside a card', () => {
  const page = 'https://t.test/';

  it('never picks the struck-through original as the deal', () => {
    const html = `<div class="product-card">
      <h3>Mini Desk Fan</h3>
      <span class="price">৳450</span>
      <del>৳900</del>
    </div>`;
    const [p] = extractProductsFromHtml(html, page, 't');
    expect(p).toMatchObject({ title: 'Mini Desk Fan', dealPrice: 450, originalPrice: 900, discountPercentage: 50 });
  });

  it('excludes EMI figures in emi/install-classed elements', () => {
    const html = `<div class="product-card">
      <h3>Galaxy Phone</h3>
      <span class="price">৳16,399</span>
      <span class="emi-price">৳1,367/month</span>
    </div>`;
    const [p] = extractProductsFromHtml(html, page, 't');
    expect(p!.dealPrice).toBe(16399);
  });

  it('excludes sold counters from the whole-card fallback', () => {
    const html = `<div class="weird-card-xyz" data-product>
      <a href="/p1"><img src="https://img.test/p.jpg" alt="Galaxy Phone A07"></a>
      <span>৳16,399</span>
      <span class="sold-count">176 Sold</span>
    </div>`;
    const [p] = extractProductsFromHtml(html, page, 't');
    expect(p!.dealPrice).toBe(16399);
  });

  it('ignores discount badges when scanning card text ("800 TK OFF" is not a price)', () => {
    const html = `<div class="product-card">
      <h3>Mixer Grinder</h3>
      <span class="price">৳3,200</span>
      <span class="discount-badge">800 TK OFF</span>
    </div>`;
    const [p] = extractProductsFromHtml(html, page, 't');
    expect(p!.dealPrice).toBe(3200);
  });
});

describe('nested card selectors', () => {
  it('do not double-count: a matched container never re-emits its cards', () => {
    // .productPane AND .productV2Catalog both match CARD_SELECTORS — the
    // innermost-first pass must yield exactly two products, not three.
    const html = `<div class="productPane">
      <div class="productV2Catalog">
        <a href="/a"><img src="https://img.test/a.jpg" alt=""></a>
        <div class="name">Product Alpha Long Name</div>
        <span class="price">৳100</span>
      </div>
      <div class="productV2Catalog">
        <a href="/b"><img src="https://img.test/b.jpg" alt=""></a>
        <div class="name">Product Beta Long Name</div>
        <span class="price">৳200</span>
      </div>
    </div>`;
    const out = extractProductsFromHtml(html, 'https://t.test/', 't');
    expect(out).toHaveLength(2);
    expect(new Set(out.map((p) => p.title)).size).toBe(2);
  });
});

describe('card with only an original (struck) price', () => {
  it('still yields the product with that price as the deal and no original', () => {
    const html = `<li class="product">
      <a href="/c"><img src="https://img.test/c.jpg" alt=""></a>
      <h2 class="woocommerce-loop-product__title">Realme C65 (6/128GB)</h2>
      <span class="price"><del><span class="amount">৳19,999</span></del></span>
    </li>`;
    const [p] = extractProductsFromHtml(html, 'https://t.test/', 't');
    expect(p).toMatchObject({ dealPrice: 19999, originalPrice: null });
  });
});

describe('lazy-cost discipline of the strategy ladder', () => {
  it('structural inference only runs when semantic strategies found nothing', () => {
    // This page has BOTH semantic cards and stray price-shaped text outside
    // them. If extractFromStructure ran, the banner price would join in.
    const html = `<div class="promo-banner"><span>৳99,999</span><span>৳88,888</span></div>
      <div class="product-card">
        <a href="/a"><img src="https://img.test/a.jpg" alt=""></a>
        <h3>Real Product Title</h3>
        <span class="price">৳500</span>
      </div>`;
    const out = extractProductsFromHtml(html, 'https://t.test/', 't');
    expect(out).toHaveLength(1);
    expect(out[0]!.dealPrice).toBe(500);
  });
});

/* ------------------------------------------------------------------ */
/* Phase 2 extraction strategies — declared data beats heuristics     */
/* ------------------------------------------------------------------ */

describe('JSON-LD (jsonld-shopify fixture)', () => {
  it('extracts ItemList products with declared prices and authoritative currency', () => {
    const out = runFixture('jsonld-shopify');
    expect(out).toHaveLength(2);
    const backpack = out.find((p) => p.title.includes('Trailblazer'))!;
    expect(backpack).toMatchObject({ dealPrice: 2950, currency: 'BDT' });
    // AggregateOffer → lowPrice wins
    const tent = out.find((p) => p.title.includes('Summit'))!;
    expect(tent.dealPrice).toBe(5400);
  });
});

describe('Next.js App Router flight data (nextjs-approuter fixture)', () => {
  it('extracts products from __next_f.push chunks — no __NEXT_DATA__ needed', () => {
    const out = runFixture('nextjs-approuter');
    expect(out).toHaveLength(2);
    const xm5 = out.find((p) => p.title.includes('WH-1000XM5'))!;
    expect(xm5).toMatchObject({ dealPrice: 32500, originalPrice: 38000, discountPercentage: 14 });
  });
});

describe('microdata', () => {
  it('reads itemprop attributes inside [itemtype*=Product] cards, content attrs first', () => {
    const html = `<div class="x" itemscope itemtype="https://schema.org/Product">
      <span itemprop="name">Declared Microdata Kettle</span>
      <meta itemprop="price" content="2499">
      <meta itemprop="priceCurrency" content="BDT">
      <link itemprop="url" href="https://t.test/kettle">
      <img itemprop="image" src="https://img.test/k.jpg">
    </div>`;
    const [p] = extractProductsFromHtml(html, 'https://t.test/', 't');
    expect(p).toMatchObject({
      title: 'Declared Microdata Kettle',
      dealPrice: 2499,
      currency: 'BDT',
      productUrl: 'https://t.test/kettle',
      imageUrl: 'https://img.test/k.jpg',
    });
  });
});

describe('OpenGraph product tags', () => {
  it('extract a single product from product:price meta tags', () => {
    const html = `<html><head>
      <meta property="og:title" content="Single Product Hoodie">
      <meta property="og:url" content="https://t.test/hoodie">
      <meta property="og:image" content="https://img.test/h.jpg">
      <meta property="product:price:amount" content="1850.00">
      <meta property="product:price:currency" content="BDT">
    </head><body><p>no cards here</p></body></html>`;
    const out = extractProductsFromHtml(html, 'https://t.test/', 't');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: 'Single Product Hoodie', dealPrice: 1850, currency: 'BDT' });
  });
});

describe('hydration globals', () => {
  it('walks window.__NUXT__ assignments', () => {
    const html = `<html><body><div id="__nuxt"></div><script>
      window.__NUXT__ = {"data":[{"products":[
        {"name":"Nuxt Storefront Sneakers","price":2990,"slug":"sneakers"},
        {"name":"Nuxt Storefront Sandals","price":1490,"slug":"sandals"}
      ]}]}];
    </script></body></html>`;
    const out = extractProductsFromHtml(html, 'https://t.test/', 't');
    expect(out.map((p) => p.title)).toEqual(
      expect.arrayContaining(['Nuxt Storefront Sneakers', 'Nuxt Storefront Sandals']),
    );
  });
});
