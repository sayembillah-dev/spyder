import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { CandidateSource } from '../types';
import { canonicalizeUrl } from './canonicalize';

/**
 * D3 Tier 1 — homepage link harvest. Pure: one fetched HTML document in,
 * deduped candidates out. WHERE a link sits is strong evidence, so regions
 * map to CandidateSource:
 *
 *   header, nav, [role=navigation], [class*=menu|nav]     → 'nav'
 *   [class*=banner|hero|slider|carousel]                  → 'hero'
 *   footer, [class*=footer]                               → 'footer'
 *   everything else                                       → 'body'
 *
 * Per anchor we collect innerText, title/aria-label AND img[alt] — banner
 * links are IMAGES, and the alt text is routinely the campaign name
 * (alt="Eid Flash Sale up to 70% off") and often the only label there is.
 */

export interface HarvestedLink {
  url: string; // canonical form
  source: CandidateSource; // best region this URL was seen in
  anchorText: string | null;
  titleText: string | null;
  /** Seen in BOTH nav and footer → a real site section, not a one-off. */
  inNavAndFooter: boolean;
}

const MAX_ANCHORS = 800;

const NAV_SEL = 'header, nav, [role="navigation"], [class*="menu" i], [class*="nav" i]';
const HERO_SEL = '[class*="banner" i], [class*="hero" i], [class*="slider" i], [class*="carousel" i]';
const FOOTER_SEL = 'footer, [class*="footer" i]';

/** Nearest region ancestor wins (a <nav> inside <footer> is footer chrome). */
function regionOf($: cheerio.CheerioAPI, el: AnyNode): CandidateSource {
  let cur = el.parent;
  while (cur && cur.type !== 'root') {
    const $cur = $(cur);
    if ($cur.is(FOOTER_SEL)) return 'footer';
    if ($cur.is(NAV_SEL)) return 'nav';
    if ($cur.is(HERO_SEL)) return 'hero';
    cur = cur.parent;
  }
  return 'body';
}

const REGION_RANK: Record<string, number> = { nav: 3, hero: 2, body: 1, footer: 0 };
const betterRegion = (a: CandidateSource, b: CandidateSource): CandidateSource =>
  (REGION_RANK[a] ?? 0) >= (REGION_RANK[b] ?? 0) ? a : b;

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

export function harvestLinks(html: string, baseUrl: string): HarvestedLink[] {
  const $ = cheerio.load(html);
  const byUrl = new Map<
    string,
    HarvestedLink & { seenNav: boolean; seenFooter: boolean }
  >();

  let seen = 0;
  $('a[href]').each((_, el) => {
    if (seen++ >= MAX_ANCHORS) return false;

    const href = ($(el).attr('href') ?? '').trim();
    if (!href) return;
    const url = canonicalizeUrl(href, baseUrl);
    if (!url) return;

    const region = regionOf($, el);
    const anchorText = collapse($(el).text()) || null;
    const titleText =
      collapse($(el).attr('title') ?? '') ||
      collapse($(el).attr('aria-label') ?? '') ||
      collapse($(el).find('img[alt]').first().attr('alt') ?? '') ||
      null;

    const existing = byUrl.get(url);
    if (!existing) {
      byUrl.set(url, {
        url,
        source: region,
        anchorText,
        titleText,
        inNavAndFooter: false,
        seenNav: region === 'nav',
        seenFooter: region === 'footer',
      });
      return;
    }
    // Dedupe on the canonical URL: keep the BEST region and the richest
    // label across duplicates — a path also found in the nav is stronger
    // than the same path found only in a sitemap/footer.
    existing.source = betterRegion(existing.source, region);
    if (!existing.anchorText && anchorText) existing.anchorText = anchorText;
    if (!existing.titleText && titleText) existing.titleText = titleText;
    existing.seenNav ||= region === 'nav';
    existing.seenFooter ||= region === 'footer';
  });

  for (const link of byUrl.values()) link.inNavAndFooter = link.seenNav && link.seenFooter;
  return [...byUrl.values()].map(({ seenNav: _n, seenFooter: _f, ...link }) => link);
}

/** How many usable anchors the homepage yielded — the Tier-4 escalation
 *  signal. An SPA shell has almost none (< 15 per the plan). */
export const USABLE_ANCHOR_FLOOR = 15;
