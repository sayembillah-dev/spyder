import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D10 — the autonomous refresh scheduler. NETWORK-FREE: guard / verify /
 * scrape are injected; the registry runs for real (in-memory). Time is a
 * mutable `NOW` the scheduler reads through hooks.now — no fake timers,
 * no hanging intervals.
 */
import { config } from '../src/config';
import * as registry from '../src/discovery/registry';
import { startScheduler, type SchedulerHooks } from '../src/discovery/scheduler';
import type { VerificationResult } from '../src/types';

const HOUR = 3_600_000;
let NOW = 1_760_000_000_000; // fixed epoch, advanced by hand between ticks

const VER = (fp: string, rejectedReason?: string): VerificationResult => ({
  productCount: 12,
  dealDensity: 0.5,
  medianDiscountPct: 30,
  quality: {
    score: 0.9,
    productCount: 12,
    pctWithRealLink: 1,
    pctWithImage: 1,
    pctWithOriginalPrice: 1,
    claimedTotal: null,
    coverage: null,
    flags: [],
  },
  hasCountdown: false,
  renderType: 'SSR',
  productFingerprint: fp,
  ...(rejectedReason ? { rejectedReason } : {}),
});

/** Seed a verified (⇒ active) record, then force it DUE. */
function seedActive(url: string, fp = 'fp-1'): registry.DealPageRecord {
  const rec = registry.upsert(
    { url, source: 'sitemap', evidence: ['test'], finalScore: 0.9, verified: VER(fp) },
    NOW,
  );
  return registry.patch(rec.id, { nextCheckAt: 1 }) ?? rec;
}

const fakeVerify = (impl: (url: string) => VerificationResult) =>
  vi.fn(async (url: string) => ({
    candidate: { url, source: 'user' as const, evidence: ['test'], priorScore: 1 },
    outcome: { verification: impl(url), products: [], html: null },
  }));

const fakeScrape = (method: 'fast-html' | 'browser' = 'fast-html') =>
  vi.fn(
    async (
      urls: string[],
      _onStatus?: unknown,
      _signal?: unknown,
      _opts?: unknown,
    ) => ({
    products: [],
    comparisons: [],
    report: urls.map((u) => ({
      url: u,
      site: 'test',
      renderType: 'SSR' as const,
      status: 'ok' as const,
      productCount: 10,
      durationMs: 5,
      method,
    })),
      totalDurationMs: 5,
      }),
  );

function makeScheduler(
  verify: ReturnType<typeof fakeVerify>,
  scrape: ReturnType<typeof fakeScrape>,
  events: string[] = [],
  extra: Partial<SchedulerHooks> = {},
) {
  return startScheduler({
    guard: async () => null, // SSRF/robots/delay pass — tested elsewhere
    verify,
    scrape,
    now: () => NOW,
    onEvent: (m) => events.push(m),
    ...extra,
  });
}

beforeEach(() => {
  registry._resetForTests();
  NOW = 1_760_000_000_000;
});

describe('D10 scheduler', () => {
  it('a 50-record registry stays bounded and jittered (never a thundering herd)', async () => {
    const urls = Array.from({ length: 50 }, (_, i) => `https://shop-${i}.com/deals`);
    for (const u of urls) seedActive(u, `fp-${u}`);
    const verify = fakeVerify((url) => VER(`fp-${url}`)); // unchanged
    const s = makeScheduler(verify, fakeScrape());

    // refreshPerTick = 5 ⇒ ten ticks to work through all fifty.
    for (let t = 0; t < 10; t++) await s.tickNow();
    await s.stop();

    expect(verify).toHaveBeenCalledTimes(50); // each exactly once
    const min = 0.85 * config.discovery.refreshMinHours * HOUR;
    const max = 1.15 * config.discovery.refreshMaxHours * HOUR;
    const gaps = urls.map((u) => {
      const rec = registry.findByUrl(u);
      expect(rec).toBeDefined();
      return rec!.nextCheckAt - NOW;
    });
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(min);
      expect(g).toBeLessThanOrEqual(max);
    }
    // Jitter: 50 identical intervals would herd every future tick.
    expect(new Set(gaps).size).toBeGreaterThan(25);
  });

  it('an unchanged page costs exactly ONE verify — no scrape', async () => {
    seedActive('https://steady.com/deals', 'fp-same');
    const verify = fakeVerify(() => VER('fp-same')); // fingerprint unchanged
    const scrape = fakeScrape();
    const events: string[] = [];
    const s = makeScheduler(verify, scrape, events);

    await s.tickNow();
    await s.stop();

    expect(verify).toHaveBeenCalledTimes(1); // the whole cost of the check
    expect(scrape).not.toHaveBeenCalled();
    const rec = registry.findByUrl('https://steady.com/deals')!;
    expect(rec.status).toBe('active');
    expect(rec.nextCheckAt).toBeGreaterThan(NOW); // rescheduled, not hot-looping
    expect(events.some((m) => m.includes('unchanged'))).toBe(true);
  });

  it('a changed fingerprint triggers the full scrape ladder (discovery never re-runs)', async () => {
    seedActive('https://churning.com/flash', 'fp-old');
    const verify = fakeVerify(() => VER('fp-new')); // changed
    const scrape = fakeScrape();
    const s = makeScheduler(verify, scrape);

    await s.tickNow();
    await s.stop();

    expect(scrape).toHaveBeenCalledTimes(1);
    expect(scrape.mock.calls[0]?.[0]).toEqual(['https://churning.com/flash']);
    expect(scrape.mock.calls[0]?.[3]).toEqual({ discovery: { enabled: 'never' } });
    const rec = registry.findByUrl('https://churning.com/flash')!;
    expect(rec.lastChangedAt).toBe(NOW);
    expect(rec.productFingerprint).toBe('fp-new');
  });

  it('two consecutive misses park the page (404s are seasonal, not fatal)', async () => {
    seedActive('https://seasonal.com/black-friday');
    const verify = fakeVerify(() => VER('', 'not-a-listing'));
    const s = makeScheduler(verify, fakeScrape());

    await s.tickNow();
    let rec = registry.findByUrl('https://seasonal.com/black-friday')!;
    expect(rec.status).toBe('stale'); // one miss: benefit of the doubt

    NOW += 9 * 24 * HOUR; // beyond any recomputed cadence
    await s.tickNow();
    await s.stop();

    rec = registry.findByUrl('https://seasonal.com/black-friday')!;
    expect(rec.status).toBe('parked');
    expect(rec.revisitAfter).toBeGreaterThan(NOW); // wakes for its season
  });

  it('pinned pages are never demoted — checks update stats only', async () => {
    const rec = seedActive('https://curated.com/daily');
    registry.patch(rec.id, { status: 'pinned' });
    const verify = fakeVerify(() => VER('', 'not-a-listing'));
    const s = makeScheduler(verify, fakeScrape());

    for (let t = 0; t < 3; t++) {
      await s.tickNow();
      NOW += 9 * 24 * HOUR;
    }
    await s.stop();

    const after = registry.findByUrl('https://curated.com/daily')!;
    expect(after.status).toBe('pinned'); // a user fact, not a machine decision
    expect(after.checkCount).toBe(1); // misses never overwrite a user fact's health
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it('blocked backs off without touching health (registry invariant #1)', async () => {
    seedActive('https://waf-shop.com/deals', 'fp-waf');
    const verify = fakeVerify(() => VER('', 'blocked:cloudflare'));
    const s = makeScheduler(verify, fakeScrape());

    await s.tickNow();
    let rec = registry.findByUrl('https://waf-shop.com/deals')!;
    expect(rec.status).toBe('active'); // NOT demoted
    expect(rec.checkCount).toBe(1); // the blocked check changed nothing
    expect(rec.nextCheckAt).toBeGreaterThanOrEqual(NOW + config.discovery.refreshMinHours * HOUR);

    await s.tickNow(); // immediately after: backed off, not retried
    await s.stop();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('N consecutive failures across DIFFERENT domains pause the loop', async () => {
    seedActive('https://down-a.com/deals');
    seedActive('https://down-b.com/deals');
    seedActive('https://down-c.com/deals');
    const verify = fakeVerify(() => VER('', 'fetch-failed'));
    const events: string[] = [];
    const s = makeScheduler(verify, fakeScrape(), events);

    await s.tickNow(); // 3 misses on 3 domains ⇒ paused
    expect(verify).toHaveBeenCalledTimes(3);
    expect(events.some((m) => m.includes('pausing'))).toBe(true);

    await s.tickNow(); // still inside the pause window: nobody is hammered
    expect(verify).toHaveBeenCalledTimes(3);

    NOW += 9 * 24 * HOUR; // past the pause AND past the recomputed cadence
    await s.tickNow();
    await s.stop();
    expect(verify).toHaveBeenCalledTimes(4); // work resumes
  });

  it('max one record per domain per tick', async () => {
    seedActive('https://busy.com/deals');
    seedActive('https://busy.com/clearance');
    const verify = fakeVerify(() => VER('fp-same'));
    const s = makeScheduler(verify, fakeScrape());

    await s.tickNow();
    expect(verify).toHaveBeenCalledTimes(1); // the second same-domain record waits

    NOW += 9 * 24 * HOUR;
    await s.tickNow();
    await s.stop();
    expect(verify).toHaveBeenCalledTimes(2); // …and gets its turn next tick
  });

  it('the browser-rung hourly cap defers scrapes (verification still happens)', async () => {
    seedActive('https://hot-a.com/deals', 'fp-a0');
    seedActive('https://hot-b.com/deals', 'fp-b0');
    const verify = fakeVerify((url) =>
      VER(url.includes('hot-a') ? 'fp-a1' : 'fp-b1'), // both changed
    );
    const scrape = fakeScrape('browser'); // every scrape launches Chromium
    const events: string[] = [];
    const s = makeScheduler(verify, scrape, events, { browserPerHour: 1 });

    await s.tickNow();
    await s.stop();

    expect(verify).toHaveBeenCalledTimes(2); // both pages checked cheaply
    expect(scrape).toHaveBeenCalledTimes(1); // but only ONE browser scrape
    expect(events.some((m) => m.includes('cap'))).toBe(true);
  });

  it('ticks never overlap, and stop() unwinds a mid-tick run', async () => {
    seedActive('https://slow.com/deals');
    let release: (v: VerificationResult) => void = () => {};
    const verify = vi.fn(
      (url: string, _label: string | null, signal?: AbortSignal) =>
        new Promise<{ candidate: never; outcome: { verification: VerificationResult; products: never[]; html: null } }>(
          (resolve, reject) => {
            release = (v) => resolve({
              candidate: undefined as never,
              outcome: { verification: v, products: [], html: null },
            });
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          },
        ),
    );
    const s = startScheduler({
      guard: async () => null,
      verify: verify as never,
      scrape: fakeScrape() as never,
      now: () => NOW,
    });

    const t1 = s.tickNow(); // starts, blocks inside verify
    const t2 = s.tickNow(); // must NOT double-run
    await t2;
    expect(verify).toHaveBeenCalledTimes(1);

    const stopped = s.stop(); // aborts the in-flight verify…
    await t1; // …the tick unwinds…
    await stopped; // …and stop() waits for it
    expect(s.running).toBe(false);
    expect(verify).toHaveBeenCalledTimes(1);
  });
});
