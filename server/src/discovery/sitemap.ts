/**
 * D3 Tier 2 — sitemap parsing. Pure: XML text in, structured entries out.
 * The fetch/cap/recursion policy lives in the tier orchestrator (D5); this
 * only understands the two sitemap document shapes.
 *
 *   <sitemapindex> → children: other sitemap documents (recursion targets)
 *   <urlset>       → urls: page entries with optional <lastmod>
 *
 * Malformed XML is tolerated (best-effort regex extraction, not a strict
 * parser — a truncated 5 MB sitemap still yields its leading URLs), and
 * entity-escaped URLs are unescaped by the XML rules for text content.
 */

export interface SitemapUrlEntry {
  loc: string;
  lastmodMs: number | null;
}

export interface SitemapDoc {
  kind: 'index' | 'urlset' | 'unknown';
  /** sitemapindex children — candidate documents to recurse into */
  children: string[];
  /** urlset entries */
  urls: SitemapUrlEntry[];
}

const MAX_ENTRIES = 20_000; // a malformed dump shouldn't allocate forever

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // LAST — order matters

function parseLastmod(raw: string | undefined): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw.trim());
  return Number.isFinite(ms) ? ms : null;
}

export function parseSitemap(xml: string): SitemapDoc {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const isUrlset = /<urlset[\s>]/i.test(xml);

  if (isIndex && !isUrlset) {
    const children: string[] = [];
    const re = /<sitemap[^>]*>[\s\S]*?<loc>([\s\S]*?)<\/loc>[\s\S]*?<\/sitemap>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) && children.length < MAX_ENTRIES) {
      const loc = unescapeXml(m[1]!.trim());
      if (loc) children.push(loc);
    }
    return { kind: 'index', children, urls: [] };
  }

  if (isUrlset) {
    const urls: SitemapUrlEntry[] = [];
    const re = /<url[^>]*>[\s\S]*?<loc>([\s\S]*?)<\/loc>([\s\S]*?)<\/url>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) && urls.length < MAX_ENTRIES) {
      const loc = unescapeXml(m[1]!.trim());
      if (!loc) continue;
      const lastmodRaw = /<lastmod>([\s\S]*?)<\/lastmod>/i.exec(m[2]!);
      urls.push({ loc, lastmodMs: parseLastmod(lastmodRaw?.[1]) });
    }
    return { kind: 'urlset', children: [], urls };
  }

  return { kind: 'unknown', children: [], urls: [] };
}
