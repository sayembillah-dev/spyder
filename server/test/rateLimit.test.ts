import { describe, expect, it } from 'vitest';
import { HostRateLimiter } from '../src/utils/rateLimit';

/**
 * Regression coverage for a self-deadlock: `runExclusive` holds a host's
 * slot for an entire scrape job, and code running inside that job
 * legitimately needs further requests to the same host (SSR pagination's
 * page-2+ fetches, a cache-miss re-detect, the learned-API fast path).
 * Before AsyncLocalStorage-based reentrancy, a nested waitTurn/runExclusive
 * call for the SAME host awaited the outer hold releasing — which never
 * happens, because the outer call is itself blocked awaiting the nested
 * one. That hung the entire request: mapWithConcurrency's Promise.all never
 * resolves, so even unrelated URLs in the same batch never get a response.
 *
 * Every test here has a short explicit timeout via Promise.race so a
 * regression fails fast instead of hanging the whole suite.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms — deadlock?`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

describe('HostRateLimiter reentrancy', () => {
  it('a nested waitTurn for a host already held by runExclusive does not deadlock', async () => {
    const limiter = new HostRateLimiter();
    const result = await withTimeout(
      limiter.runExclusive('shop.example.com', async () => {
        await limiter.waitTurn('shop.example.com'); // e.g. SSR pagination's page-2+ fetchHtml
        return 'ok';
      }),
      2000,
      'runExclusive -> nested waitTurn',
    );
    expect(result).toBe('ok');
  });

  it('a nested runExclusive for the same host does not deadlock', async () => {
    const limiter = new HostRateLimiter();
    const result = await withTimeout(
      limiter.runExclusive('shop.example.com', async () =>
        limiter.runExclusive('shop.example.com', async () => 'inner-ok'),
      ),
      2000,
      'runExclusive -> nested runExclusive',
    );
    expect(result).toBe('inner-ok');
  });

  it('still serializes two INDEPENDENT jobs on the same host (perHostConcurrency: 1 preserved)', async () => {
    const limiter = new HostRateLimiter();
    const order: string[] = [];
    const job1 = limiter.runExclusive('same-host.example', async () => {
      order.push('job1-start');
      await new Promise((r) => setTimeout(r, 60));
      order.push('job1-end');
    });
    const job2 = limiter.runExclusive('same-host.example', async () => {
      order.push('job2-start');
      order.push('job2-end');
    });
    await withTimeout(Promise.all([job1, job2]), 2000, 'two same-host jobs');
    expect(order.indexOf('job2-start')).toBeGreaterThan(order.indexOf('job1-end'));
  });

  it('does not serialize two DIFFERENT hosts against each other', async () => {
    const limiter = new HostRateLimiter();
    const order: string[] = [];
    const jobA = limiter.runExclusive('host-a.example', async () => {
      order.push('A-start');
      await new Promise((r) => setTimeout(r, 60));
      order.push('A-end');
    });
    const jobB = limiter.runExclusive('host-b.example', async () => {
      order.push('B-start');
      order.push('B-end');
    });
    await withTimeout(Promise.all([jobA, jobB]), 2000, 'two different-host jobs');
    // B (fast, independent host) must finish before A (slow) — no cross-host blocking.
    expect(order.indexOf('B-end')).toBeLessThan(order.indexOf('A-end'));
  });
});
