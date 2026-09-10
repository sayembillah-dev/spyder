/**
 * D7.1 — user include/exclude patterns (the `discovery.include` /
 * `discovery.exclude` request options). Three shapes:
 *
 *   'https://shop.example.com/campaign/*' — full-URL glob
 *   '/campaign/*'                         — path glob (same-site guard still
 *                                           applies to whatever it matches)
 *   '/campaign/eid'                       — exact path, no wildcard
 *
 * `*` matches any suffix (regex `.*`); everything else is literal; matching
 * is case-insensitive and forgiving of trailing slashes on exact patterns.
 *
 * Exact (non-glob) include patterns are additionally SEEDABLE: the
 * orchestrator injects them as candidates even when no tier surfaces them.
 * A glob cannot be seeded — you cannot fetch a `*`.
 */

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What a pattern is matched against: the full URL for absolute patterns;
 *  path(+query when the pattern itself carries a query) for slash/bare
 *  ones. A pattern without '?' matches the page regardless of sort/filter
 *  params; '/shop/?on_sale=1' pins exactly that filtered view. */
function subjectFor(pattern: string, url: string): string | null {
  if (/^https?:\/\//i.test(pattern)) return url;
  try {
    const u = new URL(url);
    return pattern.includes('?') ? u.pathname + u.search : u.pathname;
  } catch {
    return null;
  }
}

const stripTrailingSlashes = (s: string): string =>
  s.length > 1 ? s.replace(/\/+$/, '') : s;

export function matchUserPattern(pattern: string, url: string): boolean {
  let p = pattern.trim();
  if (!p || p.length > 200) return false;
  if (!/^https?:\/\//i.test(p) && !p.startsWith('/')) p = `/${p}`;
  const subject = subjectFor(p, url);
  if (subject === null) return false;

  if (!p.includes('*')) {
    return stripTrailingSlashes(p).toLowerCase() === stripTrailingSlashes(subject).toLowerCase();
  }
  try {
    return new RegExp(`^${escapeRe(p).replaceAll('\\*', '.*')}$`, 'i').test(subject);
  } catch {
    return false;
  }
}

/** First matching pattern wins; null when nothing matches. */
export function matchesAnyPattern(
  patterns: readonly string[] | undefined,
  url: string,
): string | null {
  for (const p of patterns ?? []) {
    if (matchUserPattern(p, url)) return p;
  }
  return null;
}

/** An include pattern concrete enough to seed as a candidate: no wildcard,
 *  parseable. Returns an absolute URL or root-relative path; null for globs
 *  and garbage. */
export function seedableInclude(pattern: string): string | null {
  const p = pattern.trim();
  if (!p || p.length > 200 || p.includes('*')) return null;
  if (/^https?:\/\//i.test(p)) {
    try {
      return new URL(p).href;
    } catch {
      return null;
    }
  }
  return p.startsWith('/') ? p : `/${p}`;
}
