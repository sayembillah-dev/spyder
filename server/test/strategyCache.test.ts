import { describe, expect, it } from 'vitest';
import {
  isStale,
  lookupStrategy,
  recordFailure,
  recordSuccess,
} from '../src/services/strategyCache';
import type { StrategyWin } from '../src/services/strategyCache';

const win = (over: Partial<StrategyWin> = {}): StrategyWin => ({
  renderType: 'CSR',
  method: 'browser',
  profile: 'hardened',
  extractionStrategy: 'dom',
  cardSelector: '.product-card',
  apiEndpoint: null,
  quality: 0.9,
  ...over,
});

const at = (host: string) => `https://${host}/deals`;

describe('strategyCache — a hint, never a rule', () => {
  it('returns null for unknown hosts', () => {
    expect(lookupStrategy(at('never-seen.example'))).toBeNull();
  });

  it('remembers a winning strategy and resets the failure counter', () => {
    const url = at('cache-a.example');
    recordFailure(url); // no entry yet — a no-op
    recordSuccess(url, win());
    recordFailure(url);
    recordSuccess(url, win({ quality: 0.8 }));
    const s = lookupStrategy(url)!;
    expect(s.method).toBe('browser');
    expect(s.profile).toBe('hardened');
    expect(s.cardSelector).toBe('.product-card');
    expect(s.successCount).toBe(2);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.bestQuality).toBe(0.9); // keeps the best, not the latest
  });

  it('evicts after 3 consecutive failures', () => {
    const url = at('cache-b.example');
    recordSuccess(url, win());
    expect(lookupStrategy(url)).not.toBeNull();
    recordFailure(url);
    recordFailure(url);
    expect(lookupStrategy(url)).not.toBeNull();
    recordFailure(url); // third strike
    expect(lookupStrategy(url)).toBeNull();
  });

  it('evicts a STALE entry on the first failure', () => {
    const url = at('cache-c.example');
    recordSuccess(url, win());
    // age the entry past the TTL by rewriting lastSuccessAt
    const s = lookupStrategy(url)!;
    s.lastSuccessAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
    expect(isStale(s)).toBe(true);
    recordFailure(url);
    expect(lookupStrategy(url)).toBeNull();
  });

  it('keeps learned selectors/endpoints across successes that did not re-learn them', () => {
    const url = at('cache-d.example');
    recordSuccess(url, win({ cardSelector: '.cards-x', apiEndpoint: 'https://api.example/p' }));
    recordSuccess(url, win({ cardSelector: null, apiEndpoint: null }));
    const s = lookupStrategy(url)!;
    expect(s.cardSelector).toBe('.cards-x');
    expect(s.apiEndpoint).toBe('https://api.example/p');
  });
});
