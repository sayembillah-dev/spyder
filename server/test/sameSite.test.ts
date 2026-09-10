import { describe, expect, it } from 'vitest';
import { isSameSite, registrableDomain } from '../src/utils/sameSite';

/**
 * D1.1 — same-site guard. Network-free: registrableDomain is pure string
 * work, isSameSite never resolves DNS.
 */
describe('registrableDomain', () => {
  it('handles plain gTLDs with the last-two-labels fallback', () => {
    expect(registrableDomain('chaldal.com')).toBe('chaldal.com');
    expect(registrableDomain('www.chaldal.com')).toBe('chaldal.com');
    expect(registrableDomain('shop.example.org')).toBe('example.org');
  });

  it('handles multi-part suffixes (eTLD+1)', () => {
    expect(registrableDomain('pages.daraz.com.bd')).toBe('daraz.com.bd');
    expect(registrableDomain('a.b.co.uk')).toBe('b.co.uk');
    expect(registrableDomain('daraz.com.bd')).toBe('daraz.com.bd');
  });

  it('returns null for non-sites', () => {
    expect(registrableDomain('localhost')).toBeNull();
    expect(registrableDomain('com.bd')).toBeNull(); // bare suffix, not a site
    expect(registrableDomain('127.0.0.1')).toBeNull();
    expect(registrableDomain('')).toBeNull();
  });

  it('is case- and trailing-dot-insensitive', () => {
    expect(registrableDomain('Pages.Daraz.COM.BD.')).toBe('daraz.com.bd');
  });
});

describe('isSameSite', () => {
  const root = 'https://chaldal.com';

  it('allows the same host and subdomains', () => {
    expect(isSameSite('https://chaldal.com/deals', root)).toBe(true);
    expect(isSameSite('https://www.chaldal.com/deals', root)).toBe(true);
    expect(isSameSite('https://pages.chaldal.com/x', root)).toBe(true);
  });

  it('rejects lookalike and unrelated domains', () => {
    expect(isSameSite('https://evil-chaldal.com/deals', root)).toBe(false);
    expect(isSameSite('https://chaldal.com.attacker.io/', root)).toBe(false);
    expect(isSameSite('https://daraz.com.bd/', root)).toBe(false);
  });

  it('distinguishes different registrable domains sharing a label', () => {
    // daraz.com vs daraz.com.bd are DIFFERENT sites.
    expect(isSameSite('https://daraz.com/sale', 'https://daraz.com.bd')).toBe(false);
    expect(isSameSite('https://pages.daraz.com.bd/x', 'https://daraz.com.bd')).toBe(true);
  });

  it('fails closed on malformed URLs', () => {
    expect(isSameSite('not a url', root)).toBe(false);
    expect(isSameSite('https://chaldal.com', 'not a url')).toBe(false);
  });
});
