import { hostRateLimiter } from './rateLimit';

/**
 * Minimal robots.txt check — optional (RESPECT_ROBOTS=true), with an
 * explicit override (ROBOTS_OVERRIDE=true). Only User-agent: * groups and
 * Disallow/Allow path prefixes are honoured; that's the 95% case.
 *
 * A checker that errs open (fetch fails → allowed) — robots is a courtesy
 * signal, not a security boundary.
 */

interface RobotsRules {
  disallow: string[];
  allow: string[];
  /** Sitemap: directives — the authoritative sitemap location (D3 Tier 0;
   *  zero extra network cost since robots.txt is fetched anyway). */
  sitemaps: string[];
}

const cache = new Map<string, RobotsRules | null>(); // null = no robots / unreachable

function parse(body: string): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [], sitemaps: [] };
  let inStarGroup = false;
  let seenGroup = false;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, field, value] = m as [string, string, string];
    const f = field.toLowerCase();
    if (f === 'user-agent') {
      // first * group wins; a more specific group opts out of our check
      if (!seenGroup) {
        inStarGroup = value === '*';
        seenGroup = true;
      } else if (inStarGroup && value !== '*') {
        inStarGroup = false; // a named group follows — no longer ours
      }
      continue;
    }
    // Sitemap: lines are group-independent (they sit outside agent groups).
    if (f === 'sitemap' && value) {
      rules.sitemaps.push(value);
      continue;
    }
    if (!inStarGroup) continue;
    if (f === 'disallow' && value) rules.disallow.push(value);
    if (f === 'allow' && value) rules.allow.push(value);
  }
  return rules;
}

async function rulesFor(origin: string): Promise<RobotsRules | null> {
  if (cache.has(origin)) return cache.get(origin)!;
  let rules: RobotsRules | null = null;
  try {
    const host = new URL(origin).hostname;
    await hostRateLimiter.waitTurn(host);
    const res = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(8_000) });
    if (res.ok) rules = parse(await res.text());
  } catch {
    rules = null; // unreachable robots → err open
  }
  cache.set(origin, rules);
  return rules;
}

/** Sitemap: URLs declared by this origin's robots.txt ([] when none). */
export async function sitemapsFromRobots(origin: string): Promise<string[]> {
  return (await rulesFor(origin))?.sitemaps ?? [];
}

/** Longest-prefix-match Allow wins over Disallow, per RFC 9309. */
export async function allowedByRobots(url: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const rules = await rulesFor(u.origin);
  if (!rules) return true;
  const path = u.pathname + u.search;
  let best: { len: number; allow: boolean } | null = null;
  for (const p of rules.disallow) {
    if (path.startsWith(p) && (!best || p.length > best.len)) best = { len: p.length, allow: false };
  }
  for (const p of rules.allow) {
    if (path.startsWith(p) && (!best || p.length >= best.len)) best = { len: p.length, allow: true };
  }
  return best ? best.allow : true;
}
