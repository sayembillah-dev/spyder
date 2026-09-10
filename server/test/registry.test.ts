import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetForTests,
  computeNextCheck,
  due,
  findByUrl,
  isExcluded,
  list,
  patch,
  recordCheck,
  recordId,
  remove,
  upsert,
  type DealPageRecord,
} from '../src/discovery/registry';
import type { VerificationResult } from '../src/types';

/**
 * D6 — registry lifecycle. The plan's lock-down cases:
 *   2 misses → parked (not deleted) · pinned survives every automatic rule ·
 *   excluded is never re-added by discovery · upsert refreshes evidence
 *   without resetting health · blocked changes nothing.
 *
 * All pure/in-memory: _resetForTests gives each case a fresh store, and
 * `now` is injected everywhere so cadence math is deterministic.
 */

const NOW = Date.parse('2026-09-10T12:00:00Z');

const verification = (over: Partial<VerificationResult> = {}): VerificationResult => ({
  productCount: 42,
  dealDensity: 0.8,
  medianDiscountPct: 35,
  quality: {
    score: 0.8,
    productCount: 42,
    pctWithRealLink: 1,
    pctWithImage: 1,
    pctWithOriginalPrice: 0.8,
    claimedTotal: null,
    coverage: null,
    flags: [],
  },
  hasCountdown: true,
  renderType: 'SSR',
  productFingerprint: 'fp-1',
  ...over,
});

const seed = (url: string, over: Partial<Parameters<typeof upsert>[0]> = {}) =>
  upsert(
    {
      url,
      source: 'nav',
      evidence: ['anchor:"Sale"'],
      finalScore: 0.9,
      verified: verification(),
      ...over,
    },
    NOW,
  );

beforeEach(() => _resetForTests());

describe('upsert (re-discovery)', () => {
  it('creates an active record for a verified URL', () => {
    const rec = seed('https://shop.com/deals');
    expect(rec.status).toBe('active');
    expect(rec.domain).toBe('shop.com');
    expect(rec.id).toBe(recordId('https://shop.com/deals'));
    expect(findByUrl('https://shop.com/deals')?.id).toBe(rec.id);
  });

  it('refreshes lastSeenAt + evidence WITHOUT resetting health', () => {
    const rec = seed('https://shop.com/deals');
    recordCheck(rec.id, { kind: 'ok', verification: verification(), fingerprintChanged: true }, NOW);
    const health = { checkCount: rec.checkCount, successCount: rec.successCount };

    const again = upsert(
      { url: 'https://shop.com/deals', source: 'sitemap', evidence: ['path:/deals'], finalScore: 0.95 },
      NOW + 1000,
    );
    expect(again.lastSeenAt).toBe(NOW + 1000);
    expect(again.evidence).toContain('path:/deals');
    expect(again.evidence).toContain('anchor:"Sale"');
    expect(again.checkCount).toBe(health.checkCount);
    expect(again.successCount).toBe(health.successCount);
  });

  it('never resurrects an excluded record', () => {
    const rec = seed('https://shop.com/deals');
    patch(rec.id, { status: 'excluded' });
    const again = seed('https://shop.com/deals');
    expect(again.status).toBe('excluded');
    expect(isExcluded('https://shop.com/deals')).toBe(true);
  });
});

describe('recordCheck — the D6.2 state machine', () => {
  it('2 consecutive misses park the record (NOT delete it)', () => {
    const rec = seed('https://shop.com/deals');
    recordCheck(rec.id, { kind: 'miss' }, NOW + 1000);
    expect(findByUrl('https://shop.com/deals')?.status).toBe('stale'); // one miss: benefit of the doubt
    recordCheck(rec.id, { kind: 'miss' }, NOW + 2000);
    const parked = findByUrl('https://shop.com/deals')!;
    expect(parked.status).toBe('parked');
    expect(parked.revisitAfter).not.toBeNull();
  });

  it('a parked seasonal page wakes at its next seasonHint month', () => {
    const rec = seed('https://shop.com/black-friday');
    // was live in November (month 11)
    recordCheck(rec.id, { kind: 'ok', verification: verification(), fingerprintChanged: false }, Date.parse('2025-11-28T12:00:00Z'));
    expect(rec.seasonHint).toContain(11);
    recordCheck(rec.id, { kind: 'miss' }, NOW);
    recordCheck(rec.id, { kind: 'miss' }, NOW + 1000);
    const parked = findByUrl('https://shop.com/black-friday')!;
    expect(parked.status).toBe('parked');
    // parked in September → next wake is November 1st of the same year
    expect(new Date(parked.revisitAfter!).getMonth()).toBe(10); // 0-indexed → November
  });

  it('re-verify OK from stale returns to active', () => {
    const rec = seed('https://shop.com/deals');
    recordCheck(rec.id, { kind: 'miss' }, NOW + 1000);
    expect(findByUrl('https://shop.com/deals')?.status).toBe('stale');
    recordCheck(rec.id, { kind: 'ok', verification: verification(), fingerprintChanged: false }, NOW + 2000);
    expect(findByUrl('https://shop.com/deals')?.status).toBe('active');
  });

  it('blocked changes NOTHING (invariant 1)', () => {
    const rec = seed('https://shop.com/deals');
    recordCheck(rec.id, { kind: 'ok', verification: verification(), fingerprintChanged: true }, NOW);
    const snapshot = { ...rec };
    recordCheck(rec.id, { kind: 'blocked' }, NOW + 5000);
    const after = findByUrl('https://shop.com/deals')!;
    expect(after.status).toBe(snapshot.status);
    expect(after.checkCount).toBe(snapshot.checkCount);
    expect(after.consecutiveMisses).toBe(snapshot.consecutiveMisses);
  });

  it('a pinned record is never demoted by any automatic rule (invariant 2)', () => {
    const rec = seed('https://shop.com/deals');
    patch(rec.id, { status: 'pinned' });
    recordCheck(rec.id, { kind: 'miss' }, NOW + 1000);
    recordCheck(rec.id, { kind: 'miss' }, NOW + 2000);
    recordCheck(rec.id, { kind: 'miss' }, NOW + 3000);
    expect(findByUrl('https://shop.com/deals')?.status).toBe('pinned');
  });

  it('health stats are EWMA — one bad check moves the number, never decides it', () => {
    const rec = seed('https://shop.com/deals');
    recordCheck(rec.id, { kind: 'ok', verification: verification({ dealDensity: 0.8 }), fingerprintChanged: false }, NOW + 1000);
    const d1 = findByUrl('https://shop.com/deals')!.dealDensity;
    recordCheck(rec.id, { kind: 'ok', verification: verification({ dealDensity: 0.2 }), fingerprintChanged: false }, NOW + 2000);
    const d2 = findByUrl('https://shop.com/deals')!.dealDensity;
    expect(d1).toBeCloseTo(0.8);
    expect(d2).toBeCloseTo(0.3 * 0.2 + 0.7 * 0.8); // α=0.3
  });
});

describe('computeNextCheck cadence (D10.2)', () => {
  const rec = (over: Partial<DealPageRecord>): DealPageRecord => ({
    ...(seed('https://shop.com/deals') as DealPageRecord),
    ...over,
  });

  it('high changeRate → floor (1h); zero change → ceiling (7d)', () => {
    const hot = rec({ changeRate: 1, dealDensity: 1, status: 'active' });
    const cold = rec({ changeRate: 0, dealDensity: 0, status: 'active' });
    const hotNext = computeNextCheck(hot, NOW) - NOW;
    const coldNext = computeNextCheck(cold, NOW) - NOW;
    expect(hotNext).toBeLessThanOrEqual(1.3 * 3600_000); // ~1h + jitter
    // 7d ceiling with ±15% jitter → [5.95d, 8.05d]
    expect(coldNext).toBeGreaterThanOrEqual(5.9 * 24 * 3600_000);
    expect(coldNext).toBeLessThanOrEqual(8.1 * 24 * 3600_000);
  });

  it('parked entries ignore cadence and honour revisitAfter', () => {
    const parked = rec({ status: 'parked', revisitAfter: NOW + 10_000 });
    expect(computeNextCheck(parked, NOW)).toBe(NOW + 10_000);
  });
});

describe('due() — the scheduler read (D10.1)', () => {
  it('never returns two entries of one domain; respects the per-tick cap; ordered by priority', () => {
    const a = seed('https://aaa.com/deals');
    const b = seed('https://aaa.com/offers'); // SAME domain as a
    const c = seed('https://bbb.com/deals');
    patch(c.id, { status: 'pinned' });
    for (const r of [a, b, c]) {
      r.nextCheckAt = NOW - 1000; // all due
    }
    const rows = due(NOW, 10);
    expect(rows.map((r) => r.domain).sort()).toEqual(['aaa.com', 'bbb.com']); // one per domain
    expect(rows[0]!.id).toBe(c.id); // pinned first
    expect(due(NOW, 1)).toHaveLength(1); // cap respected
  });

  it('excluded and candidate entries are never due', () => {
    const a = seed('https://ccc.com/deals');
    patch(a.id, { status: 'excluded' });
    upsert({ url: 'https://ccc.com/candidate', source: 'sitemap', evidence: [], finalScore: 0.5 }, NOW);
    expect(due(NOW, 10)).toHaveLength(0);
  });
});

describe('user actions', () => {
  it('patch pins, excludes, re-activates; remove hard-deletes', () => {
    const rec = seed('https://shop.com/deals');
    patch(rec.id, { status: 'excluded' });
    expect(findByUrl('https://shop.com/deals')?.status).toBe('excluded');
    patch(rec.id, { status: 'active', label: 'Weekly deals' });
    const after = findByUrl('https://shop.com/deals')!;
    expect(after.status).toBe('active');
    expect(after.label).toBe('Weekly deals');
    expect(remove(rec.id)).toBe(true);
    expect(findByUrl('https://shop.com/deals')).toBeUndefined();
  });
});

describe('list() — the Saved Pages view query', () => {
  it('filters by domain and status', () => {
    seed('https://aaa.com/deals');
    seed('https://bbb.com/deals');
    const parked = seed('https://bbb.com/old-sale');
    recordCheck(parked.id, { kind: 'miss' }, NOW + 1000);
    recordCheck(parked.id, { kind: 'miss' }, NOW + 2000);

    expect(list({ domain: 'bbb.com' })).toHaveLength(2);
    expect(list({ status: 'parked' })).toHaveLength(1);
    expect(list({ status: ['active', 'parked'] })).toHaveLength(3);
  });
});
