import { describe, expect, it } from 'vitest';
import { scoreCandidate } from '../src/discovery/score';

/**
 * D2.3 — the prior scorer. The plan's acceptance cases:
 * /wholesale → 0 · /flash-sale high · /blog/top-10-deals stoplisted ·
 * anchor text beats path · Bangla tokens match.
 */
describe('scoreCandidate', () => {
  it('hard-rejects NEG tokens: /wholesale scores 0', () => {
    const r = scoreCandidate({ url: 'https://x.com/wholesale', source: 'nav' });
    expect(r.score).toBe(0);
    expect(r.rejectReason).toBe('neg-token:wholesale');
    expect(r.evidence.join(' ')).toContain('wholesale');
  });

  it('hard-rejects STOP segments even with deal words in the slug', () => {
    const r = scoreCandidate({ url: 'https://x.com/blog/top-10-deals', source: 'sitemap' });
    expect(r.score).toBe(0);
    expect(r.rejectReason).toMatch(/^stop-segment:blog$/);
  });

  it('scores /flash-sale high from the path alone', () => {
    const r = scoreCandidate({ url: 'https://x.com/flash-sale', source: 'sitemap' });
    expect(r.score).toBeGreaterThan(0.7);
    expect(r.rejectReason).toBeNull();
  });

  it('anchor text beats path: merchant label > URL slug', () => {
    // A weak path with a strong anchor must outscore a strong path alone.
    const anchored = scoreCandidate({
      url: 'https://x.com/c/9f3k2',
      source: 'nav',
      anchorText: 'Flash Sale — up to 70% off',
    });
    const bare = scoreCandidate({ url: 'https://x.com/flash-sale', source: 'nav' });
    expect(anchored.score).toBeGreaterThan(0.7);
    expect(anchored.evidence.join(' ')).toContain('anchor:');
    expect(anchored.score).toBeGreaterThanOrEqual(bare.score);
  });

  it('matches Bangla anchor text', () => {
    const r = scoreCandidate({
      url: 'https://x.com/campaign/xyz',
      source: 'nav',
      anchorText: 'অফার',
    });
    expect(r.score).toBeGreaterThan(0.6);
  });

  it('title/alt text counts but below anchor text', () => {
    const titled = scoreCandidate({
      url: 'https://x.com/c/9f3k2',
      source: 'hero',
      titleText: 'Eid Flash Sale',
    });
    expect(titled.score).toBeGreaterThan(0.5);
    const anchored = scoreCandidate({
      url: 'https://x.com/c/9f3k2',
      source: 'hero',
      anchorText: 'Eid Flash Sale',
    });
    expect(anchored.score).toBeGreaterThan(titled.score);
  });

  it('rewards freshness (sitemap lastmod < 14d) and shallow paths', () => {
    const fresh = scoreCandidate({
      url: 'https://x.com/offers',
      source: 'sitemap',
      lastmodMs: Date.now() - 2 * 24 * 3600_000,
    });
    const stale = scoreCandidate({
      url: 'https://x.com/offers',
      source: 'sitemap',
      lastmodMs: Date.now() - 90 * 24 * 3600_000,
    });
    expect(fresh.score).toBeGreaterThan(stale.score);
    expect(fresh.evidence.join(' ')).toContain('lastmod');
  });

  it('penalizes deep paths, product-detail pages and faceted URLs', () => {
    const base = scoreCandidate({ url: 'https://x.com/deals', source: 'nav' });
    const deep = scoreCandidate({ url: 'https://x.com/a/b/c/d/deals', source: 'nav' });
    const pdp = scoreCandidate({ url: 'https://x.com/product/iphone-17-12845', source: 'nav' });
    const faceted = scoreCandidate({
      url: 'https://x.com/deals?page=2&sort=price&filter=on_sale',
      source: 'nav',
    });
    expect(deep.score).toBeLessThan(base.score);
    expect(pdp.score).toBeLessThan(base.score);
    expect(pdp.evidence.join(' ')).toContain('product-detail-page');
    expect(faceted.score).toBeLessThan(base.score);
  });

  it('bonuses a link repeated in both nav and footer', () => {
    const both = scoreCandidate({
      url: 'https://x.com/deals',
      source: 'nav',
      inNavAndFooter: true,
    });
    const navOnly = scoreCandidate({ url: 'https://x.com/deals', source: 'nav' });
    expect(both.score).toBeGreaterThan(navOnly.score);
  });

  it('a Black Friday link scores higher in November than in March', () => {
    const nov = scoreCandidate(
      { url: 'https://x.com/black-friday', source: 'nav' },
      { now: new Date('2026-11-20T00:00:00Z') },
    );
    const mar = scoreCandidate(
      { url: 'https://x.com/black-friday', source: 'nav' },
      { now: new Date('2026-03-20T00:00:00Z') },
    );
    expect(nov.score).toBeGreaterThan(mar.score);
  });

  it('fails safe on unparseable URLs', () => {
    const r = scoreCandidate({ url: ':::nope', source: 'probe' });
    expect(r.score).toBe(0);
    expect(r.rejectReason).toBe('unparseable-url');
  });
});
