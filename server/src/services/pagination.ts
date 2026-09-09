import * as cheerio from 'cheerio';
import type { Locator, Page } from 'playwright';
import { CARD_SELECTORS } from './extractor';

/* ------------------------------------------------------------------ */
/* Shared pagination / "load more" intelligence.                       */
/* Two flavours of multi-page content exist in the wild:               */
/*   1. Load-more buttons  — same URL, more cards appended to the DOM. */
/*   2. Pagination         — "next" controls swap the listing (either  */
/*      by navigating to ?page=N or re-rendering in place).            */
/* This module detects both, for the browser (CSR) and static (SSR).   */
/* ------------------------------------------------------------------ */

/** Button captions we recognise, incl. Bengali variants seen on BD shops. */
const LOAD_MORE_RE =
  /load\s*more|show\s*more|view\s*more|see\s*more|more\s+(deals|products|items|results)|আরও\s*দেখুন|আরো\s*দেখুন|আরো/i;

const NEXT_TEXT_RE = /^(next|next\s*[›»→]?|[›»→]|পরবর্তী|পরের\s*পাতা)$/i;

/** Class-based selectors for load-more controls (Daraz: .J_LoadMore / .flash-sale-load-more). */
const LOAD_MORE_CSS = [
  '[class*="load-more" i]',
  '[class*="loadmore" i]',
  '[class*="load_more" i]',
  '[class*="show-more" i]',
  '[class*="showmore" i]',
  '[id*="load-more" i]',
  '[id*="loadmore" i]',
];

/** Class-based selectors for "next page" controls. */
const NEXT_CSS = [
  'a[rel="next"]',
  'li.next a',
  'a.next',
  'a[aria-label*="next" i]',
  '[class*="pagination" i] a',
  '[class*="pager" i] a',
];

const CARDS_SELECTOR = CARD_SELECTORS.join(',');

/* ------------------------------------------------------------------ */
/* Page-state snapshots — ONE evaluate roundtrip per call. Heavy       */
/* pages (Daraz's Whale app) punish chatty protocols, so every poll    */
/* grabs all signals at once.                                          */
/* ------------------------------------------------------------------ */

export interface PageSnapshot {
  /** Cards matched by the extractor's selector bank (0 on exotic markup). */
  cards: number;
  /** Anchors wrapping images — grows in append-mode even on exotic markup. */
  anchorsWithImg: number;
  /** First product-ish link — changes when pagination swaps the listing. */
  firstAnchor: string;
  /** Body HTML size — append-mode growth signal. */
  htmlLen: number;
  /** First card's text — replace-mode swap signal. */
  firstCardText: string;
}

export async function snapshotPage(page: Page): Promise<PageSnapshot> {
  return page
    .evaluate((cardsSel: string) => {
      const firstAnchorEl = document.querySelector('a[href] img')?.closest('a');
      const firstCardEl = document.querySelector(cardsSel);
      return {
        cards: document.querySelectorAll(cardsSel).length,
        anchorsWithImg: document.querySelectorAll('a[href] img').length,
        firstAnchor: firstAnchorEl?.getAttribute('href') ?? '',
        htmlLen: document.body?.innerHTML.length ?? 0,
        firstCardText: (firstCardEl?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 120),
      };
    }, CARDS_SELECTOR)
    .catch(() => ({ cards: 0, anchorsWithImg: 0, firstAnchor: '', htmlLen: 0, firstCardText: '' }));
}

/** What changed between two snapshots, if anything. */
function snapshotChanged(before: PageSnapshot, after: PageSnapshot): boolean {
  if (after.cards !== before.cards) return true;
  if (after.anchorsWithImg !== before.anchorsWithImg) return true;
  if (after.firstAnchor && before.firstAnchor && after.firstAnchor !== before.firstAnchor) return true;
  if (after.firstCardText && before.firstCardText && after.firstCardText !== before.firstCardText) return true;
  return Math.abs(after.htmlLen - before.htmlLen) > 1500;
}

/**
 * Find a visible load-more control. Prefers class-based hits; falls back to
 * a text scan restricted to short elements so we don't grab a wrapper div
 * that happens to contain the whole listing.
 */
export async function findLoadMoreControl(page: Page): Promise<Locator | null> {
  for (const sel of LOAD_MORE_CSS) {
    const matches = page.locator(sel);
    const n = Math.min(await matches.count().catch(() => 0), 6);
    for (let i = 0; i < n; i++) {
      const loc = matches.nth(i);
      if (await isUsable(loc)) return loc;
    }
  }

  const byText = page
    .locator('button, a, [role="button"], div, span, li')
    .filter({ hasText: LOAD_MORE_RE });
  const n = Math.min(await byText.count().catch(() => 0), 24);
  // walk backwards — descendants come after ancestors in document order,
  // so the innermost (real button) is usually last
  for (let i = n - 1; i >= 0; i--) {
    const loc = byText.nth(i);
    const text = (await loc.innerText({ timeout: 1_200 }).catch(() => ''))?.trim() ?? '';
    if (!LOAD_MORE_RE.test(text) || text.length > 45) continue;
    if (await isUsable(loc)) return loc;
  }
  return null;
}

/**
 * Find a visible, non-disabled "next page" control. Returns null when the
 * control is absent or disabled (i.e. we're on the last page).
 */
export async function findNextPageControl(page: Page): Promise<Locator | null> {
  for (const sel of NEXT_CSS) {
    const matches = page.locator(sel);
    const n = Math.min(await matches.count().catch(() => 0), 10);
    for (let i = 0; i < n; i++) {
      const loc = matches.nth(i);
      if (!(await isUsable(loc))) continue;
      if (sel === 'a[rel="next"]') return loc;
      const text = (await loc.innerText({ timeout: 1_200 }).catch(() => ''))?.trim() ?? '';
      const aria = (await loc.getAttribute('aria-label').catch(() => null)) ?? '';
      if (NEXT_TEXT_RE.test(text) || /next/i.test(aria)) return loc;
    }
  }
  return null;
}

/**
 * Visible and not genuinely disabled. Class names and pointer-events are
 * trusted; aria-disabled is only trusted when the element can't actually
 * navigate — Othoba ships working "Next" links with aria-disabled="true".
 */
async function isUsable(loc: Locator): Promise<boolean> {
  if (!(await loc.isVisible().catch(() => false))) return false;
  return loc
    .evaluate((el) => {
      const cls = `${el.className?.toString() ?? ''} ${el.parentElement?.className?.toString() ?? ''}`;
      if (/disabled|inactive/i.test(cls)) return false;
      if (getComputedStyle(el).pointerEvents === 'none') return false;
      if (el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')) {
        const href = el.getAttribute('href') ?? '';
        if (!href || href === '#' || href.startsWith('javascript:') || href === location.href) {
          return false;
        }
      }
      return true;
    })
    .catch(() => false);
}

/**
 * Click a control with a REAL mouse click — sites like Daraz ignore
 * untrusted dispatchEvent clicks (event.isTrusted checks). Scrolling is
 * done via evaluate because scrollIntoViewIfNeeded's actionability loop
 * stalls on pages with constant animation. A DOM-level click is kept as
 * last resort for covered elements.
 */
export async function clickControl(page: Page, loc: Locator): Promise<boolean> {
  try {
    await loc.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  } catch {
    /* element detached between find and click */
    return false;
  }
  await page.waitForTimeout(300);
  try {
    await loc.click({ timeout: 4_000 });
    return true;
  } catch {
    return loc
      .evaluate((el) => (el as HTMLElement).click())
      .then(() => true)
      .catch(() => false);
  }
}

/**
 * After a click, wait until the listing actually changes: more cards, new
 * anchors, a swapped first card, a body-size jump, or a URL change.
 * Returns true as soon as a change is seen; false on timeout.
 */
export async function waitForContentChange(
  page: Page,
  before: PageSnapshot,
  beforeUrl: string,
  timeoutMs = 9_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.url() !== beforeUrl) return true;
    const now = await snapshotPage(page);
    if (snapshotChanged(before, now)) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* SSR side: discover the next page's URL from static HTML.            */
/* ------------------------------------------------------------------ */

function abs(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    return u.protocol.startsWith('http') ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Heuristics, in order:
 *   1. <a rel="next">
 *   2. next-ish caption inside pagination containers
 *   3. a link carrying the incremented ?page=N param (or /page/N/ path)
 * A disabled next-caption control suppresses the numeric fallback —
 * it means "you are on the last page".
 */
export function findNextPageUrl(html: string, currentUrl: string): string | null {
  const $ = cheerio.load(html);

  const relNext = abs($('a[rel="next"][href]').first().attr('href'), currentUrl);
  if (relNext && relNext !== currentUrl) return relNext;

  let byText: string | null = null;
  $('[class*="pagination" i] a[href], [class*="pager" i] a[href], nav a[href]').each((_, el) => {
    if (byText) return;
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    const cls = `${$(el).attr('class') ?? ''} ${$(el).parent().attr('class') ?? ''}`;
    if (/disabled|inactive/i.test(cls)) return;
    if (NEXT_TEXT_RE.test(t) && t.length <= 20) {
      // Dead controls ("#", javascript:) are not a next page — skip them here
      // and let the disabled-next scan below decide whether they suppress the
      // numeric fallback ("you are on the last page").
      const href = $(el).attr('href') ?? '';
      if (!href || href === '#' || href.startsWith('javascript:')) return;
      const resolved = abs(href, currentUrl);
      if (resolved && resolved !== currentUrl) byText = resolved;
    }
  });
  if (byText && byText !== currentUrl) return byText;

  let disabledNext = false;
  $('[class*="pagination" i] a, [class*="pager" i] a, nav a, [class*="pagination" i] span, [class*="pager" i] span').each(
    (_, el) => {
      if (disabledNext) return;
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      const cls = `${$(el).attr('class') ?? ''} ${$(el).parent().attr('class') ?? ''}`;
      const aria = $(el).attr('aria-disabled');
      // sloppy markup ships working links with aria-disabled — a real,
      // navigable href overrides the flag (spans have no href → still disabled)
      const href = $(el).attr('href') ?? '';
      const navigable =
        href.length > 0 && href !== '#' && !href.startsWith('javascript:') && abs(href, currentUrl) !== currentUrl;
      if (NEXT_TEXT_RE.test(t) && (/disabled|inactive/i.test(cls) || (aria === 'true' && !navigable))) {
        disabledNext = true;
      }
    },
  );
  if (disabledNext) return null;

  const curMatch = currentUrl.match(/[?&](?:page|p|pageNo|pageNumber)=(\d+)/i);
  const cur = curMatch ? parseInt(curMatch[1] as string, 10) : 1;
  const wanted = cur + 1;
  let byParam: string | null = null;
  $('a[href]').each((_, el) => {
    if (byParam) return;
    const full = abs($(el).attr('href'), currentUrl);
    if (!full || full === currentUrl) return;
    const m =
      full.match(/[?&](?:page|p|pageNo|pageNumber)=(\d+)/i) ?? full.match(/\/page\/(\d+)(?:[/?]|$)/);
    if (m && parseInt(m[1] as string, 10) === wanted) byParam = full;
  });
  return byParam;
}
