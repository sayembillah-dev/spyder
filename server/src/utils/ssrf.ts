import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { config } from '../config';

export class BlockedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedTargetError';
  }
}

/**
 * SSRF guard — reject anything not routable on the public internet.
 *
 * POST /api/scrape accepts arbitrary URLs; axios AND a headless Chromium
 * fetch them, and response content flows back into extracted products and
 * error messages. Without this guard, http://169.254.169.254/latest/meta-data/,
 * http://localhost:6379 and http://10.0.0.5/admin all sail through, and a
 * public URL can 302 into any of them.
 *
 * Residual TOCTOU window: DNS could re-resolve to a private address between
 * this check and the actual fetch. Closing it fully needs a pinned-IP agent;
 * the browser rung's route-level abort (which re-checks every request,
 * including XHR) is the pragmatic mitigation for a self-hosted tool.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new BlockedTargetError(`Unsupported protocol: ${u.protocol}`);
  }
  if (config.allowPrivateTargets) return u;
  if (!(await resolvesPublicly(u.hostname))) {
    throw new BlockedTargetError(`Refusing non-public target: ${u.hostname}`);
  }
  return u;
}

/**
 * True when EVERY address the hostname resolves to is public unicast.
 * Fail-closed: a hostname we cannot resolve answers "not public" — the
 * fetch would have failed anyway.
 */
/** Per-host result cache — the browser route guard fires per REQUEST, and
 *  re-resolving the same host for every asset would dominate page load.
 *  Short TTL so a rebound DNS answer can't linger for a whole run. */
const resolveCache = new Map<string, { ok: boolean; expiresAt: number }>();
const RESOLVE_CACHE_TTL_MS = 5 * 60_000;

export async function resolvesPublicly(hostname: string): Promise<boolean> {
  // Literal IPs skip DNS entirely.
  if (ipaddr.isValid(hostname)) return ipaddr.parse(hostname).range() === 'unicast';

  const cached = resolveCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.ok;

  let ok = false;
  try {
    const results = await lookup(hostname, { all: true });
    ok =
      results.length > 0 &&
      results.every(({ address }) => ipaddr.parse(address).range() === 'unicast');
  } catch {
    ok = false; // fail-closed: unresolvable hosts would fail the fetch anyway
  }
  resolveCache.set(hostname, { ok, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
  return ok;
}

/** Schemes a browser page legitimately loads that must bypass DNS checks. */
const BENIGN_BROWSER_SCHEMES = /^(data|about|blob|chrome|chrome-extension|devtools):/i;

/**
 * Route-level guard for the browser rung: abort any request that resolves
 * to a non-public address. Unlike the fetch-time check this also covers
 * XHR/fetch issued by the page's own JS — a public page cannot pivot the
 * browser into the internal network.
 */
export async function isAllowedBrowserRequest(rawUrl: string): Promise<boolean> {
  if (BENIGN_BROWSER_SCHEMES.test(rawUrl)) return true;
  if (!/^https?:\/\//i.test(rawUrl)) return false;
  if (config.allowPrivateTargets) return true;
  try {
    return await resolvesPublicly(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}
