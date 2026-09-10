import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/ssrf', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/utils/ssrf')>();
  return { ...mod, assertPublicUrl: async (url: string) => new URL(url) };
});
vi.mock('../src/utils/robots', () => ({
  sitemapsFromRobots: async () => [] as string[],
  allowedByRobots: async () => true,
}));

import { discoverDealPages } from '../src/discovery';
import type { DealPageRecord, UpsertInput, CheckOutcome } from '../src/discovery/registry';

const fx = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', 'discovery', name), 'utf8');
const DEALS = fx('deal-page.html');
const HOME = fx('shopify-home.html');

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

const savedRecord = (url: string, over: Partial<DealPageRecord> = {}): DealPageRecord => ({
  id: `id-${url}`,
  url,
  domain: 'acme-store.com',
  site: 'Acme',
  status: 'active',
  source: 'nav',
  evidence: ['anchor:"Sale"'],
  label: 'Sale',
  firstSeenAt: 1,
  lastSeenAt: 1,
  lastVerifiedAt: 1,
  lastScrapedAt: null,
  lastChangedAt: null,
  nextCheckAt: 1,
  revisitAfter: null,
  finalScore: 0.9,
  dealDensity: 0.8,
  avgProductCount: 40,
  medianDiscountPct: 30,
  productFingerprint: 'old-fp',
  checkCount: 5,
  successCount: 5,
  consecutiveMisses: 0,
  changeRate: 0.5,
  seasonHint: [9],
  userPinned: false,
  notes: null,
  ...over,
});

function fakeRegistry(records: DealPageRecord[]) {
  const upserted: UpsertInput[] = [];
  const checks: Array<{ id: string; outcome: CheckOutcome }> = [];
  return {
    upserted,
    checks,
    registry: {
      recordsFor: (_domain: string) => records,
      upsert: (input: UpsertInput) => void upserted.push(input),
      recordCheck: (id: string, outcome: CheckOutcome) => void checks.push({ id, outcome }),
      isExcluded: () => false,
    },
  };
}

describe('D6.5 — how a run uses the registry + memo', () => {
  it('warm start: saved live pages verify cheap and skip full discovery', async () => {
    const { fetchFn, calls } = fakeWeb({
      'https://acme-store.com/deals': DEALS,
      'https://acme-store.com/offers': DEALS.replace('Wireless Earbuds Pro', 'Gadget Alpha')
        .replace('Smart Watch X2', 'Gadget Beta')
        .replace('Bluetooth Speaker Mini', 'Gadget Gamma'),
    });
    const reg = fakeRegistry([
      savedRecord('https://acme-store.com/deals'),
      savedRecord('https://acme-store.com/offers'),
    ]);
    const { report, selected } = await discoverDealPages('acme-store.com', {
      fetchFn,
      registry: reg.registry,
      robotsSitemaps: async () => [],
    });

    expect(report.fromMemo).toBe(true);
    expect(selected).toHaveLength(2);
    // the homepage was NEVER fetched — warm start goes straight to saved URLs
    expect(calls).not.toContain('https://acme-store.com/');
    // health was updated for both records
    expect(reg.checks).toHaveLength(2);
    expect(reg.checks.every((c) => c.outcome.kind === 'ok')).toBe(true);
    // ~2 fetches total (one per saved page) — the plan's "~2s warm run"
    expect(report.fetchCount).toBeLessThanOrEqual(3);
  });

  it('majority-dead saved list falls through to FULL discovery and seeds the frontier', async () => {
    // both saved URLs are absent from the fake web → they 404
    const { fetchFn } = fakeWeb({
      'https://acme-store.com/': HOME,
      'https://acme-store.com/collections/sale': DEALS,
      'https://acme-store.com/collections/clearance': DEALS,
    });
    const reg = fakeRegistry([
      savedRecord('https://acme-store.com/dead-1'),
      savedRecord('https://acme-store.com/dead-2'),
    ]);
    const { report, selected } = await discoverDealPages('acme-store.com', {
      fetchFn,
      registry: reg.registry,
      robotsSitemaps: async () => [],
    });

    // full discovery ran — found the nav's deal pages
    expect(selected.some((c) => c.url.includes('/collections/sale'))).toBe(true);
    // misses were recorded against the dead records
    expect(reg.checks.filter((c) => c.outcome.kind === 'miss')).toHaveLength(2);
    expect(report.fromMemo).toBe(true);
  });

  it('every VERIFIED URL is upserted — including top-K losers', async () => {
    const { fetchFn } = fakeWeb({
      'https://acme-store.com/': HOME,
      'https://acme-store.com/collections/sale': DEALS,
      'https://acme-store.com/collections/clearance': DEALS.replace('Wireless Earbuds Pro', 'G1')
        .replace('Smart Watch X2', 'G2')
        .replace('Bluetooth Speaker Mini', 'G3'),
      'https://acme-store.com/collections/all': fx('category-page.html'),
      'https://acme-store.com/collections/new-arrivals': fx('category-page.html'),
    });
    const reg = fakeRegistry([]); // empty registry → cold discovery
    const { report } = await discoverDealPages('acme-store.com', {
      fetchFn,
      registry: reg.registry,
      robotsSitemaps: async () => [],
      limits: { maxScrape: 1 }, // force a top-K loser
    });
    expect(report.fromMemo).toBe(false);
    // ≥2 verified deal pages exist; only 1 is selected; BOTH must be saved
    expect(reg.upserted.length).toBeGreaterThanOrEqual(2);
    expect(reg.upserted.every((u) => u.verified !== undefined)).toBe(true);
  });

  it('excluded URLs are filtered before scoring — never fetched', async () => {
    const { fetchFn, calls } = fakeWeb({
      'https://acme-store.com/': HOME,
      'https://acme-store.com/collections/clearance': DEALS,
      'https://acme-store.com/collections/all': fx('category-page.html'),
      'https://acme-store.com/collections/new-arrivals': fx('category-page.html'),
    });
    const reg = fakeRegistry([]);
    const excluded = new Set(['https://acme-store.com/collections/sale']);
    await discoverDealPages('acme-store.com', {
      fetchFn,
      registry: { ...reg.registry, isExcluded: (u) => excluded.has(u) },
      robotsSitemaps: async () => [],
    });
    expect(calls.some((u) => u.includes('/collections/sale'))).toBe(false);
  });
});
