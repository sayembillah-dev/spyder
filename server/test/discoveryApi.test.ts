import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D7 — the HTTP surface: POST /api/scrape (targets + discovery options +
 * saved-list mode), GET /api/discover, the registry CRUD/refresh/import/
 * export endpoints, and the SSE stream's discovery event.
 *
 * NETWORK-FREE: SSRF, robots, verification fetches, discovery and the
 * scrape ladder are all stubbed at the module boundary; the REAL registry
 * runs in-memory (reset per test). What is exercised for real: request
 * parsing/validation, routing, status codes, and the registry state
 * machine behind the endpoints.
 */

vi.mock('../src/utils/ssrf', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/utils/ssrf')>();
  return { ...mod, assertPublicUrl: async (url: string) => new URL(url) };
});
vi.mock('../src/utils/robots', () => ({
  sitemapsFromRobots: async () => [] as string[],
  allowedByRobots: async () => true,
}));
vi.mock('../src/services/scraperService', () => ({
  scrapeUrls: vi.fn(async () => ({
    products: [],
    comparisons: [],
    report: [],
    totalDurationMs: 5,
  })),
}));
vi.mock('../src/discovery/index', () => ({
  discoverDealPages: vi.fn(async () => ({
    report: {
      domain: 'shop.example.com',
      platform: 'shopify',
      candidatesFound: 4,
      candidatesVerified: 2,
      selected: [],
      rejected: [],
      fetchCount: 3,
      durationMs: 120,
      fromMemo: false,
      budgetExhausted: false,
    },
    selected: [],
    verified: [],
    preFetchedHtml: new Map(),
    preVerifiedProducts: new Map(),
    platform: 'shopify',
  })),
}));
vi.mock('../src/discovery/verify', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/discovery/verify')>();
  return { ...mod, verifyCandidate: vi.fn() };
});

import { createApp } from '../src/app';
import { scrapeUrls } from '../src/services/scraperService';
import { discoverDealPages } from '../src/discovery';
import { verifyCandidate } from '../src/discovery/verify';
import * as registry from '../src/discovery/registry';
import type { VerificationResult } from '../src/types';

const scrapeMock = vi.mocked(scrapeUrls);
const discoverMock = vi.mocked(discoverDealPages);
const verifyMock = vi.mocked(verifyCandidate);

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);
beforeEach(() => {
  registry._resetForTests();
  vi.clearAllMocks(); // clears calls, keeps factory implementations
  verifyMock.mockReset();
});

/* ── helpers ── */

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const verification = (over: Partial<VerificationResult> = {}): VerificationResult => ({
  productCount: 20,
  dealDensity: 0.8,
  medianDiscountPct: 35,
  quality: {
    score: 0.9,
    productCount: 20,
    pctWithRealLink: 1,
    pctWithImage: 1,
    pctWithOriginalPrice: 0.9,
    claimedTotal: null,
    coverage: null,
    flags: [],
  },
  hasCountdown: false,
  renderType: 'SSR',
  productFingerprint: 'fp-1',
  ...over,
});

const okOutcome = (over: Partial<VerificationResult> = {}) => ({
  verification: verification(over),
  products: [],
  html: '<html></html>',
});

const failOutcome = (rejectedReason: string) => ({
  verification: verification({ productCount: 0, dealDensity: 0, rejectedReason }),
  products: [],
  html: null,
});

/** Seed a record straight into the registry (bypasses the API). */
function seed(
  url: string,
  over: { verified?: boolean; status?: 'pinned' | 'excluded' | 'active' } = {},
): registry.DealPageRecord {
  const rec = registry.upsert({
    url,
    source: 'sitemap',
    evidence: ['seed'],
    finalScore: 0.9,
    verified: over.verified === false ? undefined : verification(),
  });
  if (over.status) registry.patch(rec.id, { status: over.status });
  return registry.get(rec.id)!;
}

/* ── POST /api/scrape — D7.1 request shape ── */

describe('POST /api/scrape', () => {
  it('legacy {urls} keeps working, discovery options default', async () => {
    const res = await post('/api/scrape', { urls: ['https://a.example.com/x'] });
    expect(res.status).toBe(200);
    expect(scrapeMock).toHaveBeenCalledTimes(1);
    expect(scrapeMock.mock.calls[0]?.[0]).toEqual(['https://a.example.com/x']);
    expect(scrapeMock.mock.calls[0]?.[3]).toEqual({ discovery: {} });
  });

  it('passes targets + discovery options through to the service', async () => {
    const discovery = {
      enabled: 'always',
      maxScrape: 2,
      minDiscountPercent: 10,
      include: ['/campaign/*'],
      exclude: ['/blog/*'],
    };
    const res = await post('/api/scrape', { targets: ['shop.example.com'], discovery });
    expect(res.status).toBe(200);
    expect(scrapeMock.mock.calls[0]?.[0]).toEqual(['shop.example.com']);
    expect(scrapeMock.mock.calls[0]?.[3]?.discovery).toEqual(discovery);
  });

  it('rejects invalid discovery options with a 400 naming the knob', async () => {
    for (const discovery of [
      { enabled: 'sometimes' },
      { maxScrape: 0 },
      { maxScrape: 11 },
      { minDiscountPercent: 101 },
      { include: 'not-an-array' },
      { exclude: ['ok', 42] },
    ]) {
      const res = await post('/api/scrape', { targets: ['a.example.com'], discovery });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/discovery\./);
    }
    expect(scrapeMock).not.toHaveBeenCalled();
  });

  it('empty targets with an empty saved list is a 400 explaining both fixes', async () => {
    const res = await post('/api/scrape', { targets: [] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/saved list is empty/);
    expect(scrapeMock).not.toHaveBeenCalled();
  });

  it('empty targets scrapes the saved list with discovery forced OFF', async () => {
    seed('https://saved.example.com/deals');
    seed('https://pinned.example.com/sale', { status: 'pinned' });
    // A candidate (never verified) is NOT on the scrape list.
    seed('https://unverified.example.com/x', { verified: false });

    const res = await post('/api/scrape', { targets: [] });
    expect(res.status).toBe(200);
    const urls = scrapeMock.mock.calls[0]?.[0] as string[];
    expect(urls).toHaveLength(2);
    expect(urls).toContain('https://saved.example.com/deals');
    expect(urls).toContain('https://pinned.example.com/sale');
    expect(scrapeMock.mock.calls[0]?.[3]?.discovery?.enabled).toBe('never');
  });

  it('invalid URLs are a 400, not a mid-scrape 500', async () => {
    const res = await post('/api/scrape', { targets: ['not a url at all ::'] });
    expect(res.status).toBe(400);
  });
});

/* ── GET /api/discover — D7.1 inspection endpoint ── */

describe('GET /api/discover', () => {
  it('requires a parseable domain', async () => {
    expect((await fetch(`${base}/api/discover`)).status).toBe(400);
    expect((await fetch(`${base}/api/discover?domain=not a domain`)).status).toBe(400);
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it('runs discovery on the normalized root and returns the report', async () => {
    const res = await fetch(`${base}/api/discover?domain=shop.example.com`);
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report.domain).toBe('shop.example.com');
    expect(report.platform).toBe('shopify');
    expect(discoverMock).toHaveBeenCalledTimes(1);
    expect(discoverMock.mock.calls[0]?.[0]).toBe('https://shop.example.com/');
  });

  it('forwards include/exclude/maxScrape query params', async () => {
    const res = await fetch(
      `${base}/api/discover?domain=shop.example.com&maxScrape=2&include=${encodeURIComponent('/campaign/*')}&exclude=${encodeURIComponent('/blog/*')}`,
    );
    expect(res.status).toBe(200);
    expect(discoverMock.mock.calls[0]?.[1]).toMatchObject({
      include: ['/campaign/*'],
      exclude: ['/blog/*'],
      limits: { maxScrape: 2 },
    });
  });
});

/* ── Registry CRUD — D7.3 ── */

describe('registry endpoints', () => {
  it('GET /api/registry lists, filters, sorts and caps', async () => {
    expect((await (await fetch(`${base}/api/registry`)).json()).total).toBe(0);

    // NB: registry domain is the REGISTRABLE domain (eTLD+1).
    seed('https://www.shop-one.com/deals');
    seed('https://shop-two.com/sale', { status: 'pinned' });
    seed('https://www.shop-one.com/maybe', { verified: false }); // candidate

    const all = await (await fetch(`${base}/api/registry`)).json();
    expect(all.total).toBe(3);

    const byDomain = await (await fetch(`${base}/api/registry?domain=shop-one.com`)).json();
    expect(byDomain.total).toBe(2);

    const pinnedOnly = await (await fetch(`${base}/api/registry?status=pinned`)).json();
    expect(pinnedOnly.records).toHaveLength(1);
    expect(pinnedOnly.records[0].status).toBe('pinned');

    const multi = await (
      await fetch(`${base}/api/registry?status=pinned,active`)
    ).json();
    expect(multi.total).toBe(2);

    const capped = await (await fetch(`${base}/api/registry?limit=1`)).json();
    expect(capped.records).toHaveLength(1);
    expect(capped.total).toBe(3);

    expect((await fetch(`${base}/api/registry?status=bogus`)).status).toBe(400);
    expect((await fetch(`${base}/api/registry?sort=bogus`)).status).toBe(400);
    expect((await fetch(`${base}/api/registry?limit=0`)).status).toBe(400);
  });

  it('POST /api/registry verifies before accepting (201 + active record)', async () => {
    verifyMock.mockResolvedValue(okOutcome());
    const res = await post('/api/registry', {
      url: 'https://new.example.com/eid-sale',
      label: 'Eid Sale',
      notes: 'found by hand',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.record.status).toBe('active');
    expect(body.record.source).toBe('user');
    expect(body.record.label).toBe('Eid Sale');
    expect(body.record.notes).toBe('found by hand');
    expect(body.record.evidence).toContain('manual-add');
    // A manual add is a top-prior candidate — still measured by the gate.
    expect(verifyMock.mock.calls[0]?.[0]).toMatchObject({ source: 'user', priorScore: 1 });
  });

  it('POST /api/registry turns a bad URL away with a 400, not a bad row', async () => {
    verifyMock.mockResolvedValue(failOutcome('no-discounts'));
    const res = await post('/api/registry', { url: 'https://thin.example.com/campaign' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('no-discounts');
    expect(registry.list()).toHaveLength(0);

    expect((await post('/api/registry', { url: 'not a url ::' })).status).toBe(400);
    expect((await post('/api/registry', {})).status).toBe(400);
  });

  it('POST /api/registry falls back to a real scrape for CSR shells it cannot cheap-verify', async () => {
    verifyMock.mockResolvedValue(failOutcome('unverified-csr'));
    scrapeMock.mockResolvedValueOnce({
      products: Array.from({ length: 10 }, (_, i) => ({
        id: `p${i}`,
        title: `Product ${i}`,
        originalPrice: 200,
        dealPrice: 100,
        discountPercentage: 50,
        currency: 'BDT',
        sourceSite: 'Spa',
        productUrl: `https://spa.example.com/p/${i}`,
        imageUrl: null,
      })),
      comparisons: [],
      report: [],
      totalDurationMs: 50,
    });
    const res = await post('/api/registry', { url: 'https://spa.example.com/deals' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.record.status).toBe('active');
    expect(body.record.evidence).toContain('verified-via-scrape');
    expect(body.verification.renderType).toBe('CSR');
    expect(body.verification.dealDensity).toBe(1);
  });

  it('POST /api/registry is idempotent for known URLs and 409s excluded ones', async () => {
    const existing = seed('https://known.example.com/deals');
    const dupe = await post('/api/registry', { url: 'https://known.example.com/deals' });
    expect(dupe.status).toBe(200);
    expect((await dupe.json()).record.id).toBe(existing.id);
    expect(verifyMock).not.toHaveBeenCalled();

    seed('https://no.example.com/deals', { status: 'excluded' });
    const res = await post('/api/registry', { url: 'https://no.example.com/deals' });
    expect(res.status).toBe(409);
    expect((await res.json()).record.status).toBe('excluded');
  });

  it('PATCH pins, excludes and edits; rejects bad input', async () => {
    const rec = seed('https://x.example.com/deals');

    const pinned = await fetch(`${base}/api/registry/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pinned', label: 'My Sale', notes: 'check weekly' }),
    });
    expect(pinned.status).toBe(200);
    const body = await pinned.json();
    expect(body.record.status).toBe('pinned');
    expect(body.record.userPinned).toBe(true);
    expect(body.record.label).toBe('My Sale');
    expect(body.record.notes).toBe('check weekly');

    const bad = await fetch(`${base}/api/registry/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'candidate' }),
    });
    expect(bad.status).toBe(400);
    expect(
      (await fetch(`${base}/api/registry/${rec.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nextCheckAt: 'soon' }),
      })).status,
    ).toBe(400);
    expect(
      (await fetch(`${base}/api/registry/nope`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'pinned' }),
      })).status,
    ).toBe(404);
  });

  it('DELETE hard-deletes (distinct from excluded, which is remembered)', async () => {
    const rec = seed('https://x.example.com/deals');
    expect((await fetch(`${base}/api/registry/${rec.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(registry.get(rec.id)).toBeUndefined();
    expect((await fetch(`${base}/api/registry/${rec.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('POST /api/registry/:id/refresh verifies, feeds health, and scrapes', async () => {
    const rec = seed('https://x.example.com/deals');
    verifyMock.mockResolvedValue(okOutcome({ productFingerprint: 'fp-new' }));
    scrapeMock.mockResolvedValueOnce({
      products: [{ id: 'p1' }],
      comparisons: [],
      report: [{ url: rec.url, status: 'ok', productCount: 1 }],
      totalDurationMs: 10,
    } as never);

    const res = await post(`/api/registry/${rec.id}/refresh`, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fingerprintChanged).toBe(true); // fp-1 → fp-new
    expect(body.scrape.products).toHaveLength(1);
    // The health state machine got the check (checkCount = the upsert's
    // first EWMA sample + this refresh = 2).
    expect(registry.get(rec.id)?.checkCount).toBe(2);
    // The scrape ran with discovery OFF — this exact page, nothing else.
    expect(scrapeMock.mock.calls[0]?.[3]?.discovery?.enabled).toBe('never');

    expect((await post(`/api/registry/nope/refresh`, {})).status).toBe(404);
  });

  it('POST /api/registry/refresh runs the due set (a manual scheduler tick)', async () => {
    const due1 = seed('https://a.example.com/deals');
    seed('https://b.example.com/not-due');
    registry.patch(due1.id, { nextCheckAt: 1 }); // force due
    verifyMock.mockResolvedValue(okOutcome());

    const res = await post(`/api/registry/refresh`, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checked).toBe(1);
    expect(body.results[0]).toMatchObject({ id: due1.id, outcome: 'ok', fingerprintChanged: false });
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });

  it('export → import round-trips; import never clobbers pinned/excluded', async () => {
    seed('https://a.example.com/deals', { status: 'pinned', verified: true });
    seed('https://b.example.com/sale');

    const json = await (await fetch(`${base}/api/registry/export?format=json`)).json();
    expect(json).toHaveLength(2);

    const csvRes = await fetch(`${base}/api/registry/export?format=csv`);
    expect(csvRes.headers.get('content-type')).toContain('text/csv');
    const csv = await csvRes.text();
    expect(csv.split('\n')[0]).toBe('url,domain,label,status,dealDensity,lastVerifiedAt');
    expect(csv.split('\n')).toHaveLength(3);

    // Import a clobbering attempt on the pinned record + one fresh URL.
    const res = await post('/api/registry/import', {
      records: [
        { ...json.find((r: { url: string }) => r.url === 'https://a.example.com/deals'), status: 'candidate', dealDensity: 0 },
        { url: 'https://fresh.example.com/deals' },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 1, skipped: 1 });
    const stillPinned = registry.findByUrl('https://a.example.com/deals');
    expect(stillPinned?.status).toBe('pinned');
    expect(registry.findByUrl('https://fresh.example.com/deals')?.status).toBe('candidate');

    expect((await post('/api/registry/import', { records: [{}] })).status).toBe(400);
    expect((await post('/api/registry/import', {})).status).toBe(400);
  });
});

/* ── SSE — D7.2 ── */

describe('GET /api/scrape/stream', () => {
  it('streams site-status + discovery + done events', async () => {
    scrapeMock.mockImplementationOnce(async (_urls, onStatus, _signal, opts) => {
      onStatus?.({ url: 'https://shop.example.com/', site: 'Shop', phase: 'discovering', message: '🔎 …' });
      opts?.onDiscovery?.({ domain: 'shop.example.com', candidatesFound: 4 } as never);
      return { products: [], comparisons: [], report: [], totalDurationMs: 5 };
    });
    const res = await fetch(
      `${base}/api/scrape/stream?urls=${encodeURIComponent('["https://shop.example.com/deals"]')}`,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('event: site-status');
    expect(body).toContain('event: discovery');
    expect(body).toContain('event: done');
  });

  it('empty targets + empty saved list is a 400 before the stream opens', async () => {
    const res = await fetch(`${base}/api/scrape/stream?urls=${encodeURIComponent('[]')}`);
    expect(res.status).toBe(400);
  });

  it('invalid discovery JSON is a 400 before the stream opens', async () => {
    const res = await fetch(
      `${base}/api/scrape/stream?urls=${encodeURIComponent('["a.example.com"]')}&discovery=${encodeURIComponent('{"enabled":"yolo"}')}`,
    );
    expect(res.status).toBe(400);
  });
});
