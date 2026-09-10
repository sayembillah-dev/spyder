import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D7 — the scrapeUrls ⇄ discovery wiring. NETWORK-FREE: discovery,
 * detection, fetching and the browser are all stubbed at the module
 * boundary; the real code under test is target classification, per-domain
 * dedupe, provenance plumbing, pre-fetched HTML reuse, the post-filter and
 * the option forwarding. Fixture extraction (cheerio) runs for real.
 */

vi.mock('../src/utils/ssrf', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/utils/ssrf')>();
  return { ...mod, assertPublicUrl: async (url: string) => new URL(url) };
});
vi.mock('../src/utils/robots', () => ({
  sitemapsFromRobots: async () => [] as string[],
  allowedByRobots: async () => true,
}));
vi.mock('../src/services/strategyCache', () => ({
  lookupStrategy: () => null,
  recordSuccess: () => {},
  recordFailure: () => {},
  hostOf: (url: string) => new URL(url).hostname,
}));
vi.mock('../src/services/detector', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/services/detector')>();
  return {
    ...mod,
    fetchHtml: vi.fn(async () => {
      throw new Error('network disabled in tests');
    }),
    detectRenderingType: vi.fn(async (url: string) => ({
      url,
      renderType: 'CSR' as const,
      html: '',
      framework: null,
      textLength: 0,
      hasPrices: false,
    })),
  };
});
vi.mock('../src/services/csrScraper', () => ({
  scrapeCsrSite: vi.fn(async (url: string, site: string) => [
    {
      id: 'csr-1',
      title: 'CSR product',
      originalPrice: null,
      dealPrice: 100,
      discountPercentage: null,
      currency: 'BDT',
      sourceSite: site,
      productUrl: url,
      imageUrl: null,
    },
  ]),
}));
vi.mock('../src/discovery/index', () => ({ discoverDealPages: vi.fn() }));

import { scrapeUrls, isRootTarget } from '../src/services/scraperService';
import { discoverDealPages } from '../src/discovery';
import { detectRenderingType, fetchHtml } from '../src/services/detector';
import { scrapeCsrSite } from '../src/services/csrScraper';
import type { DealCandidate } from '../src/types';
import type { DiscoveryOutcome } from '../src/discovery';

const discoverMock = vi.mocked(discoverDealPages);
const detectMock = vi.mocked(detectRenderingType);
const fetchMock = vi.mocked(fetchHtml);
const csrMock = vi.mocked(scrapeCsrSite);

const fx = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', 'discovery', name), 'utf8');
const DEALS_HTML = fx('deal-page.html'); // 12 discounted cards, SSR

const quality = { score: 0.9, productCount: 12, pctWithRealLink: 1, pctWithImage: 1, pctWithOriginalPrice: 1, claimedTotal: null, coverage: null, flags: [] as string[] };

function candidate(url: string, score: number, renderType: 'SSR' | 'CSR' = 'SSR'): DealCandidate {
  return {
    url,
    source: 'nav',
    evidence: ['test'],
    priorScore: score,
    finalScore: score,
    verified: {
      productCount: 12,
      dealDensity: 0.9,
      medianDiscountPct: 40,
      quality,
      hasCountdown: true,
      renderType,
      productFingerprint: `fp-${url}`,
    },
  };
}

/** A canned discovery outcome: two SSR winners carrying pre-fetched HTML. */
function twoWinnerOutcome(domain: string): DiscoveryOutcome {
  const selected = [
    candidate(`https://${domain}/deals`, 0.9),
    candidate(`https://${domain}/clearance`, 0.8),
  ];
  return {
    report: {
      domain,
      platform: 'shopify',
      candidatesFound: 4,
      candidatesVerified: 2,
      selected,
      rejected: [],
      fetchCount: 3,
      durationMs: 120,
      fromMemo: false,
      budgetExhausted: false,
    },
    selected,
    verified: selected,
    preFetchedHtml: new Map(selected.map((c) => [c.url, DEALS_HTML])),
    preVerifiedProducts: new Map(),
    platform: 'shopify',
  };
}

const emptyOutcome = (domain: string): DiscoveryOutcome => ({
  report: {
    domain,
    platform: null,
    candidatesFound: 5,
    candidatesVerified: 3,
    selected: [],
    rejected: [],
    fetchCount: 5,
    durationMs: 200,
    fromMemo: false,
    budgetExhausted: false,
  },
  selected: [],
  verified: [],
  preFetchedHtml: new Map(),
  preVerifiedProducts: new Map(),
  platform: null,
});

beforeEach(() => {
  vi.clearAllMocks(); // clears calls, keeps factory implementations
  discoverMock.mockReset();
});

describe('isRootTarget', () => {
  it('bare domains and site roots are discovery-eligible; deep paths are not', () => {
    expect(isRootTarget('https://chaldal.com/')).toBe(true);
    expect(isRootTarget('https://chaldal.com')).toBe(true);
    expect(isRootTarget('https://chaldal.com/flash-sale')).toBe(false);
    expect(isRootTarget('https://chaldal.com/?utm=x')).toBe(false);
  });
});

describe('scrapeUrls × discovery', () => {
  it("auto: a deep path skips discovery entirely (explicit path = explicit instruction)", async () => {
    const result = await scrapeUrls(['https://shop.example.com/deals/x']);
    expect(discoverMock).not.toHaveBeenCalled();
    expect(detectMock).toHaveBeenCalledTimes(1);
    expect(csrMock).toHaveBeenCalledTimes(1); // CSR-mocked detection → browser rung
    expect(result.products).toHaveLength(1);
    expect(result.discovery).toBeUndefined();
    expect(result.report[0]).toMatchObject({ status: 'ok' });
    expect(result.report[0]?.discoveredFrom).toBeUndefined();
  });

  it('auto: a bare domain discovers, scrapes the winners, and never refetches verified HTML', async () => {
    discoverMock.mockResolvedValue(twoWinnerOutcome('shop.example.com'));
    const discoveryEvents: unknown[] = [];
    const result = await scrapeUrls(['shop.example.com'], () => {}, undefined, {
      discovery: { enabled: 'auto' },
      onDiscovery: (r) => discoveryEvents.push(r),
    });

    expect(discoverMock).toHaveBeenCalledTimes(1);
    expect(discoverMock.mock.calls[0]?.[0]).toBe('https://shop.example.com/');

    // Winners scraped from the verification-fetched HTML — zero refetch,
    // zero re-detection, zero browser.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(detectMock).not.toHaveBeenCalled();
    expect(csrMock).not.toHaveBeenCalled();
    expect(result.products.length).toBe(24); // 12 fixture cards × 2 pages

    // D7.4 provenance on every report row. discoveredFrom is the
    // REGISTRABLE domain (eTLD+1): shop.example.com → example.com.
    const byUrl = new Map(result.report.map((r) => [r.url, r]));
    expect(byUrl.get('https://shop.example.com/deals')).toMatchObject({
      status: 'ok',
      discoveredFrom: 'example.com',
      candidateScore: 0.9,
    });
    expect(byUrl.get('https://shop.example.com/clearance')).toMatchObject({
      discoveredFrom: 'example.com',
      candidateScore: 0.8,
    });

    // One discovery event + report attached to the result.
    expect(discoveryEvents).toHaveLength(1);
    expect(result.discovery).toHaveLength(1);
    expect(result.discovery?.[0]?.domain).toBe('shop.example.com');
  });

  it("never: old behavior — every target scraped exactly as given", async () => {
    const result = await scrapeUrls(['shop.example.com'], () => {}, undefined, {
      discovery: { enabled: 'never' },
    });
    expect(discoverMock).not.toHaveBeenCalled();
    expect(detectMock).toHaveBeenCalledTimes(1);
    expect(result.report[0]?.url).toBe('https://shop.example.com/');
  });

  it("always: discovery runs for a deep path AND the path still scrapes", async () => {
    discoverMock.mockResolvedValue(twoWinnerOutcome('shop.example.com'));
    const result = await scrapeUrls(['https://shop.example.com/flash-sale'], () => {}, undefined, {
      discovery: { enabled: 'always' },
    });
    expect(discoverMock).toHaveBeenCalledTimes(1);
    const urls = result.report.map((r) => r.url);
    expect(urls).toContain('https://shop.example.com/flash-sale'); // explicit
    expect(urls).toContain('https://shop.example.com/deals'); // discovered
    expect(urls).toContain('https://shop.example.com/clearance'); // discovered
    expect(result.report.find((r) => r.url.endsWith('/flash-sale'))?.discoveredFrom).toBeUndefined();
  });

  it('two roots of one registrable domain run discovery exactly once', async () => {
    discoverMock.mockResolvedValue(twoWinnerOutcome('shop.example.com'));
    await scrapeUrls(['shop.example.com', 'www.shop.example.com']);
    expect(discoverMock).toHaveBeenCalledTimes(1);
  });

  it('forwards include/exclude/maxScrape to the orchestrator', async () => {
    discoverMock.mockResolvedValue(twoWinnerOutcome('shop.example.com'));
    await scrapeUrls(['shop.example.com'], () => {}, undefined, {
      discovery: {
        enabled: 'auto',
        maxScrape: 2,
        include: ['/campaign/*'],
        exclude: ['/blog/*'],
      },
    });
    expect(discoverMock.mock.calls[0]?.[1]).toMatchObject({
      include: ['/campaign/*'],
      exclude: ['/blog/*'],
      limits: { maxScrape: 2 },
    });
  });

  it('minDiscountPercent post-filters the products', async () => {
    discoverMock.mockResolvedValue(twoWinnerOutcome('shop.example.com'));
    const unfiltered = await scrapeUrls(['shop.example.com']);
    discoverMock.mockResolvedValue(twoWinnerOutcome('shop.example.com'));
    const filtered = await scrapeUrls(['shop.example.com'], () => {}, undefined, {
      discovery: { minDiscountPercent: 50 },
    });
    expect(filtered.products.length).toBeLessThanOrEqual(unfiltered.products.length);
    const expected = unfiltered.products.filter(
      (p) =>
        (p.discountPercentage ??
          (p.originalPrice !== null && p.originalPrice > p.dealPrice
            ? (1 - p.dealPrice / p.originalPrice) * 100
            : 0)) >= 50,
    );
    expect(filtered.products.length).toBe(expected.length);
  });

  it('a domain with no deal pages is an explicit error row, not silence', async () => {
    discoverMock.mockResolvedValue(emptyOutcome('empty.example.com'));
    const statuses: string[] = [];
    const result = await scrapeUrls(
      ['empty.example.com'],
      (e) => void statuses.push(e.phase),
      undefined,
      { discovery: { enabled: 'auto' } },
    );
    expect(result.products).toEqual([]);
    expect(result.report).toHaveLength(1);
    expect(result.report[0]).toMatchObject({
      status: 'error',
      error: 'No deal pages found',
      discoveredFrom: 'example.com', // eTLD+1 of empty.example.com
    });
    expect(result.discovery).toHaveLength(1);
    expect(statuses).toContain('discovering');
    expect(statuses).toContain('error');
  });

  it('a failing discovery does not sink the other targets', async () => {
    discoverMock.mockRejectedValue(new Error('boom'));
    const result = await scrapeUrls(
      ['shop.example.com', 'https://direct.example.com/x'],
      () => {},
      undefined,
      { discovery: { enabled: 'auto' } },
    );
    const byUrl = new Map(result.report.map((r) => [r.url, r]));
    expect(byUrl.get('https://shop.example.com/')).toMatchObject({
      status: 'error',
      error: 'Discovery failed: boom',
    });
    expect(byUrl.get('https://direct.example.com/x')).toMatchObject({ status: 'ok' });
  });

  /* ── D9: category-listing fallbacks return discounted products ONLY ── */

  const CAT_DEALS_HTML = fx('category-deals-page.html'); // 8 cards, exactly 2 discounted

  const fallbackOutcome = (domain: string, marked: boolean): DiscoveryOutcome => {
    const c = candidate(`https://${domain}/collections/pantry`, 0.49);
    c.source = 'body';
    if (marked) c.evidence = [...c.evidence, 'fallback:category-listing'];
    return {
      report: {
        domain: 'example.com', // eTLD+1 of the test host
        platform: null,
        candidatesFound: 1,
        candidatesVerified: 1,
        selected: [c],
        rejected: [],
        fetchCount: 2,
        durationMs: 50,
        fromMemo: false,
        budgetExhausted: false,
      },
      selected: [c],
      verified: [c],
      preFetchedHtml: new Map([[c.url, CAT_DEALS_HTML]]),
      preVerifiedProducts: new Map(),
      platform: null,
    };
  };

  it('D9: a fallback-marked target is post-filtered to discounted products only', async () => {
    discoverMock.mockResolvedValue(fallbackOutcome('plain.example.com', true));
    const result = await scrapeUrls(['plain.example.com'], () => {}, undefined, {
      discovery: { enabled: 'auto' },
    });
    // 8 cards on the page, exactly 2 carrying an original price.
    expect(result.products).toHaveLength(2);
    expect(
      result.products.every(
        (p) => p.originalPrice !== null || (p.discountPercentage ?? 0) > 0,
      ),
    ).toBe(true);
  });

  it('D9: the same page WITHOUT the fallback marker returns everything', async () => {
    discoverMock.mockResolvedValue(fallbackOutcome('plain.example.com', false));
    const result = await scrapeUrls(['plain.example.com'], () => {}, undefined, {
      discovery: { enabled: 'auto' },
    });
    expect(result.products).toHaveLength(8); // pins the filter to the marker
  });
});
