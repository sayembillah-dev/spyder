import { describe, expect, it } from 'vitest';
import {
  matchUserPattern,
  matchesAnyPattern,
  seedableInclude,
} from '../src/discovery/userPatterns';

/**
 * D7.1 — the include/exclude pattern language. Pure functions, no mocks.
 */
describe('matchUserPattern', () => {
  const URL = 'https://shop.example.com/deals/eid?sort=best';

  it('matches an exact path, forgiving trailing slashes and case', () => {
    expect(matchUserPattern('/deals/eid', URL)).toBe(true);
    expect(matchUserPattern('/deals/eid/', URL)).toBe(true);
    expect(matchUserPattern('/DEALS/EID', URL)).toBe(true);
    expect(matchUserPattern('/deals/eid', 'https://shop.example.com/deals/eid/')).toBe(true);
  });

  it('a pattern without ? matches the page regardless of query params', () => {
    expect(matchUserPattern('/deals/eid', URL)).toBe(true);
    expect(matchUserPattern('/deals/eid', 'https://shop.example.com/deals/eid')).toBe(true);
  });

  it('a pattern WITH ? pins exactly that filtered view', () => {
    expect(matchUserPattern('/deals/eid?sort=best', URL)).toBe(true);
    expect(matchUserPattern('/deals/eid?sort=cheap', URL)).toBe(false);
    expect(matchUserPattern('/shop/?on_sale=1', 'https://x.example.com/shop/?on_sale=1')).toBe(true);
    expect(matchUserPattern('/shop/?on_sale=1', 'https://x.example.com/shop/')).toBe(false);
  });

  it('does not prefix-match without a wildcard', () => {
    expect(matchUserPattern('/deals', URL)).toBe(false);
    expect(matchUserPattern('/deals', 'https://shop.example.com/deals')).toBe(true);
  });

  it('supports * globs on paths', () => {
    expect(matchUserPattern('/campaign/*', 'https://shop.example.com/campaign/eid-2026')).toBe(true);
    expect(matchUserPattern('/campaign/*', 'https://shop.example.com/deals')).toBe(false);
    expect(matchUserPattern('campaign/*', 'https://shop.example.com/campaign/x')).toBe(true);
  });

  it('supports full-URL patterns (host included)', () => {
    expect(matchUserPattern('https://shop.example.com/deals/*', URL)).toBe(true);
    expect(matchUserPattern('https://other.example.com/deals/*', URL)).toBe(false);
    expect(matchUserPattern('https://shop.example.com/deals/eid?sort=best', URL)).toBe(true);
  });

  it('rejects garbage safely', () => {
    expect(matchUserPattern('', URL)).toBe(false);
    expect(matchUserPattern('   ', URL)).toBe(false);
    expect(matchUserPattern('x'.repeat(201), URL)).toBe(false);
    expect(matchUserPattern('/deals', 'not a url')).toBe(false);
  });
});

describe('matchesAnyPattern', () => {
  it('returns the first matching pattern, or null', () => {
    const patterns = ['/blog/*', '/deals/eid'];
    expect(matchesAnyPattern(patterns, 'https://x.example.com/blog/10-deals')).toBe('/blog/*');
    expect(matchesAnyPattern(patterns, 'https://x.example.com/deals/eid')).toBe('/deals/eid');
    expect(matchesAnyPattern(patterns, 'https://x.example.com/shop')).toBeNull();
    expect(matchesAnyPattern(undefined, 'https://x.example.com/blog/x')).toBeNull();
    expect(matchesAnyPattern([], 'https://x.example.com/blog/x')).toBeNull();
  });
});

describe('seedableInclude', () => {
  it('exact paths and URLs are seedable; globs and garbage are not', () => {
    expect(seedableInclude('/campaign/eid')).toBe('/campaign/eid');
    expect(seedableInclude('campaign/eid')).toBe('/campaign/eid');
    expect(seedableInclude('https://x.example.com/deals')).toBe('https://x.example.com/deals');
    expect(seedableInclude('/campaign/*')).toBeNull();
    expect(seedableInclude('')).toBeNull();
    expect(seedableInclude('http://[')).toBeNull();
  });
});
