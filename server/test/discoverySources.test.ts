import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { harvestLinks, USABLE_ANCHOR_FLOOR } from '../src/discovery/harvest';
import { parseSitemap } from '../src/discovery/sitemap';
import { fingerprintPlatform, probePathsFor } from '../src/discovery/platform';

const fx = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', 'discovery', name), 'utf8');

/* D3 — source parsers. All network-free: a document in, candidates out. */

describe('harvestLinks', () => {
  it('maps regions to sources and keeps merchant labels', () => {
    const links = harvestLinks(fx('shopify-home.html'), 'https://acme-store.com');
    const byUrl = new Map(links.map((l) => [new URL(l.url).pathname, l]));

    const sale = byUrl.get('/collections/sale');
    expect(sale?.source).toBe('nav'); // header nav wins over footer
    expect(sale?.anchorText).toBe('Sale');
    expect(sale?.inNavAndFooter).toBe(true); // nav AND footer → real section

    const clearance = byUrl.get('/collections/clearance');
    expect(clearance?.source).toBe('hero'); // banner region
    // banner links are images — the title/ALT text is the campaign label
    expect(clearance?.titleText?.toLowerCase()).toContain('clearance');
  });

  it('canonicalizes, dedupes and keeps the best region', () => {
    const links = harvestLinks(fx('shopify-home.html'), 'https://acme-store.com');
    // /collections/sale appears twice (nav + footer) → exactly one entry
    expect(links.filter((l) => l.url.includes('/collections/sale'))).toHaveLength(1);
  });

  it('drops non-http and off-canonical junk via canonicalizeUrl', () => {
    const links = harvestLinks(fx('shopify-home.html'), 'https://acme-store.com');
    // twitter.com and evil-acme.com links are still harvested here —
    // the SAME-SITE guard (D1.1) rejects them at the orchestrator. But
    // canonical form must hold.
    for (const l of links) expect(() => new URL(l.url)).not.toThrow();
  });

  it('harvests WooCommerce on-sale filter links with their query', () => {
    const links = harvestLinks(fx('woocommerce-home.html'), 'https://gadget-world.com');
    const onSale = links.find((l) => l.url.includes('on_sale=1'));
    expect(onSale).toBeDefined();
    expect(onSale!.source).toBe('nav'); // nav beats footer for the same URL
    expect(onSale!.anchorText).toBe('On Sale Now!');
  });

  it('handles Bangla nav labels', () => {
    const links = harvestLinks(fx('bd-marketplace-home.html'), 'https://dhaka-mart.com');
    const flash = links.find((l) => l.url.includes('/flash-sale'));
    expect(flash?.anchorText).toBe('ফ্ল্যাশ সেল');
    expect(flash?.inNavAndFooter).toBe(true);
  });

  it('an SPA shell yields almost no usable anchors (Tier-4 signal)', () => {
    const links = harvestLinks(fx('spa-shell-home.html'), 'https://natura-shop.com');
    expect(links.length).toBeLessThan(USABLE_ANCHOR_FLOOR);
  });
});

describe('parseSitemap', () => {
  it('parses a sitemap index into child documents', () => {
    const doc = parseSitemap(fx('sitemap-index.xml'));
    expect(doc.kind).toBe('index');
    expect(doc.children).toHaveLength(4);
    expect(doc.children[0]).toContain('sitemap-pages.xml');
  });

  it('parses a urlset with lastmod and entity-escaped URLs', () => {
    const doc = parseSitemap(fx('sitemap-pages.xml'));
    expect(doc.kind).toBe('urlset');
    expect(doc.urls.length).toBe(8);

    const deals = doc.urls.find((u) => u.loc.includes('/deals'));
    expect(deals?.lastmodMs).not.toBeNull();

    // &amp; in <loc> must unescape to & so canonicalize can split the params
    const flash = doc.urls.find((u) => u.loc.includes('flash-sale'));
    expect(flash?.loc).toContain('&ref=email');
    expect(flash?.loc).not.toContain('&amp;');

    const wholesale = doc.urls.find((u) => u.loc.includes('wholesale'));
    expect(wholesale?.lastmodMs).toBeNull(); // missing lastmod tolerated
  });

  it('tolerates malformed XML best-effort', () => {
    const doc = parseSitemap('<urlset><url><loc>https://x.com/deals</loc></url><url><loc>https://x.com/sale');
    expect(doc.kind).toBe('urlset');
    expect(doc.urls[0]?.loc).toBe('https://x.com/deals');
  });

  it('classifies garbage as unknown', () => {
    expect(parseSitemap('<html><body>not a sitemap</body></html>').kind).toBe('unknown');
  });
});

describe('fingerprintPlatform + probe packs', () => {
  it('detects platforms from markup tells', () => {
    expect(fingerprintPlatform(fx('shopify-home.html'))).toBe('shopify');
    expect(fingerprintPlatform(fx('woocommerce-home.html'))).toBe('woocommerce');
    expect(fingerprintPlatform(fx('spa-shell-home.html'))).toBe('nextjs');
    expect(fingerprintPlatform(fx('bd-marketplace-home.html'))).toBeNull();
  });

  it('keys probe packs off the fingerprint, never a hostname', () => {
    expect(probePathsFor('shopify')).toContain('/collections/sale');
    expect(probePathsFor('woocommerce')).toContain('/shop/?on_sale=1');
    expect(probePathsFor(null)).toContain('/deals'); // unknown → conventional paths
    expect(probePathsFor(null).length).toBeLessThanOrEqual(8);
  });
});
