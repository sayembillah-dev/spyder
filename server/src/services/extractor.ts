import * as cheerio from 'cheerio';
import {
  computeDiscount,
  detectCurrency,
  extractAmounts,
  makeId,
  parsePrice,
} from '../utils/price';
import type { ScrapedProduct } from '../types';

const MAX_PRODUCTS_PER_SITE = 80;
/** Anything below this is a stray number (quantity, index), not a price. */
const MIN_DEAL_PRICE = 10;

/* ------------------------------------------------------------------ */
/* Selector banks — generic on purpose; add site-specific ones here.   */
/* ------------------------------------------------------------------ */

const CARD_SELECTORS = [
  '[itemtype*="Product"]',
  '[data-product]',
  '[data-product-id]',
  '.product',
  '.product-card',
  '.productCard',
  '.product-item',
  '.product-box',
  '.product-tile',
  '[class*="product-card"]',
  '[class*="productCard"]',
  '[class*="product-item"]',
  '[class*="productItem"]',
  '[class*="product-tile"]',
  '[class*="ProductCard"]',
  '[class*="product-block"]',
  'li[class*="product"]',
  // proven in the wild: pickaboo (.product-one__single), chaldal (.productV2Catalog / .productPane)
  '[class*="product-"]',
  '[class*="product_"]',
  '[class*="productV2"]',
  '[class*="productPane"]',
];

const TITLE_SELECTORS = [
  'h1', 'h2', 'h3', 'h4',
  '[class*="title"]', '[class*="Title"]',
  '[class*="name"]', '[class*="Name"]',
  '.product-title', '.product-name',
];

const ORIGINAL_PRICE_HOST =
  'del, s, strike, [class*="old"], [class*="Old"], [class*="regular"], [class*="Regular"], [class*="mrp"], [class*="MRP"], [class*="compare"], [class*="was"], [class*="Was"], [class*="discounted"] [class*="price"], [style*="line-through"]';
const DEAL_PRICE_HOST =
  '[class*="price"], [class*="Price"], [class*="amount"], [class*="Amount"], [class*="sale"], [class*="Sale"], [class*="offer"], [class*="Offer"], ins';
const DISCOUNT_HOST =
  '[class*="discount"], [class*="Discount"], [class*="off"], [class*="Off"], [class*="badge"], [class*="Badge"]';

const PRICE_TEXT = /(?:৳|Tk\.?|BDT|\$)\s*[\d,]{2,}/i;

/* ------------------------------------------------------------------ */
/* Public entry point — shared by the SSR path (axios HTML) and the    */
/* CSR path (Playwright's rendered page.content()).                    */
/* ------------------------------------------------------------------ */

export function extractProductsFromHtml(
  html: string,
  pageUrl: string,
  site: string,
): ScrapedProduct[] {
  const $ = cheerio.load(html);
  const viaJson = extractFromNextData($, pageUrl, site);
  const viaDom = extractFromDom($, pageUrl, site);

  const deduped = new Map<string, ScrapedProduct>();
  for (const p of [...viaJson, ...viaDom]) {
    const key = `${p.title.toLowerCase()}|${p.dealPrice}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, p);
    } else {
      // JSON path is strong on prices but often lacks images/links — backfill
      // anything the DOM twin caught instead of dropping the duplicate.
      if (!existing.imageUrl && p.imageUrl) existing.imageUrl = p.imageUrl;
      if (existing.productUrl === p.productUrl || existing.productUrl === pageUrl) {
        if (p.productUrl && p.productUrl !== pageUrl) existing.productUrl = p.productUrl;
      }
      if (existing.originalPrice === null && p.originalPrice !== null && p.originalPrice > existing.dealPrice) {
        existing.originalPrice = p.originalPrice;
        if (existing.discountPercentage === null) {
          existing.discountPercentage = p.discountPercentage;
        }
      }
    }
  }
  return [...deduped.values()].slice(0, MAX_PRODUCTS_PER_SITE);
}

/* ------------------------------------------------------------------ */
/* Strategy 1: <script id="__NEXT_DATA__"> — Next.js embeds the whole  */
/* server-fetched props payload as JSON. We deep-walk it and pick out  */
/* arrays of product-shaped objects.                                   */
/* ------------------------------------------------------------------ */

const NAME_KEYS = ['name', 'title', 'productName', 'product_name', 'displayName', 'itemName', 'productTitle'];
const DEAL_PRICE_KEYS = ['dealPrice', 'salePrice', 'sellingPrice', 'discountPrice', 'discountedPrice', 'specialPrice', 'offerPrice', 'currentPrice', 'salesPrice', 'unitPrice', 'price', 'sale_price', 'selling_price'];
const ORIGINAL_PRICE_KEYS = ['originalPrice', 'mrp', 'regularPrice', 'listPrice', 'oldPrice', 'marketPrice', 'basePrice', 'priceBeforeDiscount', 'retailPrice', 'compareAtPrice'];
const IMAGE_KEYS = ['image', 'imageUrl', 'image_url', 'img', 'thumbnail', 'thumb', 'photo', 'picture', 'imagePath', 'featuredImage', 'images'];
const URL_KEYS = ['productUrl', 'url', 'link', 'href', 'slug', 'permalink', 'canonicalUrl', 'webUrl'];
const DISCOUNT_KEYS = ['discountPercentage', 'discountPercent', 'discount_percent', 'percentOff', 'offPercentage', 'discount'];

type JsonObj = Record<string, unknown>;

function firstKey(obj: JsonObj, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function looksLikeProduct(o: unknown): o is JsonObj {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const obj = o as JsonObj;
  const name = firstKey(obj, NAME_KEYS);
  const price = parsePrice(firstKey(obj, DEAL_PRICE_KEYS));
  return typeof name === 'string' && name.trim().length > 3 && price !== null;
}

function mapJsonProduct(o: JsonObj, pageUrl: string, site: string): ScrapedProduct | null {
  const titleRaw = firstKey(o, NAME_KEYS);
  const title = typeof titleRaw === 'string' ? clean(titleRaw) : null;
  const deal = parsePrice(firstKey(o, DEAL_PRICE_KEYS));
  if (!title || title.length < 4 || deal === null || deal < MIN_DEAL_PRICE) return null;

  let original = parsePrice(firstKey(o, ORIGINAL_PRICE_KEYS));
  if (original !== null && original <= deal) original = null;

  let imageRaw = firstKey(o, IMAGE_KEYS);
  if (Array.isArray(imageRaw)) imageRaw = imageRaw[0];
  if (imageRaw && typeof imageRaw === 'object') {
    const imgObj = imageRaw as JsonObj;
    imageRaw = (imgObj.url ?? imgObj.src ?? imgObj.href) as unknown;
  }

  const urlRaw = firstKey(o, URL_KEYS);
  const productUrl = absUrl(typeof urlRaw === 'string' ? urlRaw : null, pageUrl) ?? pageUrl;

  const discRaw = firstKey(o, DISCOUNT_KEYS);
  const discNum = typeof discRaw === 'number' ? discRaw : parsePrice(discRaw);
  const discount =
    discNum !== null && discNum > 0 && discNum <= 95 ? Math.round(discNum) : computeDiscount(original, deal);

  const currency = detectCurrency(
    [firstKey(o, DEAL_PRICE_KEYS), firstKey(o, ORIGINAL_PRICE_KEYS)].find((v) => typeof v === 'string') ?? '',
  );

  return {
    id: makeId(site, productUrl, title),
    title,
    originalPrice: original,
    dealPrice: deal,
    discountPercentage: discount,
    currency,
    sourceSite: site,
    productUrl,
    imageUrl: absUrl(typeof imageRaw === 'string' ? imageRaw : null, pageUrl),
  };
}

function extractFromNextData(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  site: string,
): ScrapedProduct[] {
  const raw = $('#__NEXT_DATA__').first().html();
  if (!raw) return [];

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }

  const found: ScrapedProduct[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown, depth: number): void => {
    if (node === null || depth > 12 || found.length >= MAX_PRODUCTS_PER_SITE) return;

    if (Array.isArray(node)) {
      const objects = node.filter((x): x is JsonObj => !!x && typeof x === 'object' && !Array.isArray(x));
      const productish = objects.filter(looksLikeProduct);
      // An array where ≥ half the objects look like products = a product listing.
      if (objects.length >= 2 && productish.length >= Math.ceil(objects.length * 0.5)) {
        for (const o of productish) {
          const p = mapJsonProduct(o, pageUrl, site);
          if (p) {
            const key = `${p.title.toLowerCase()}|${p.dealPrice}`;
            if (!seen.has(key)) {
              seen.add(key);
              found.push(p);
            }
          }
        }
      }
      node.forEach((x) => walk(x, depth + 1));
      return;
    }

    if (typeof node === 'object') {
      Object.values(node as JsonObj).forEach((v) => walk(v, depth + 1));
    }
  };

  walk(data, 0);
  return found;
}

/* ------------------------------------------------------------------ */
/* Strategy 2: DOM selectors — find product cards, then read title,    */
/* prices, image and link from inside each card.                       */
/* ------------------------------------------------------------------ */

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

function absUrl(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function pickTitle($: cheerio.CheerioAPI, $card: cheerio.Cheerio<any>): string | null {
  for (const sel of TITLE_SELECTORS) {
    const t = clean($card.find(sel).first().text());
    if (t.length >= 4 && t.length <= 220) return t;
  }
  const alt = $card.find('img[alt]').first().attr('alt');
  if (alt && clean(alt).length >= 4) return clean(alt);
  const aTitle = $card.find('a[title]').first().attr('title');
  if (aTitle && clean(aTitle).length >= 4) return clean(aTitle);
  return null;
}

/**
 * Link search: the card itself → descendants → wrapping anchor → up to 3
 * parent scopes (some layouts put the <a> beside the card content).
 */
function pickLink($card: cheerio.Cheerio<any>, pageUrl: string): string | null {
  if ($card.is('a')) {
    const own = absUrl($card.attr('href'), pageUrl);
    if (own) return own;
  }
  const inner = absUrl($card.find('a[href]').first().attr('href'), pageUrl);
  if (inner) return inner;
  const wrapping = absUrl($card.closest('a[href]').attr('href'), pageUrl);
  if (wrapping) return wrapping;
  let scope = $card;
  for (let i = 0; i < 3; i++) {
    scope = scope.parent();
    if (!scope.length) break;
    const h = absUrl(scope.find('a[href]').first().attr('href'), pageUrl);
    if (h) return h;
  }
  return null;
}

/**
 * Image search: inside the card first, then up to 2 parent scopes — card
 * layouts often split image and text into sibling containers.
 */
function pickImage($card: cheerio.Cheerio<any>, pageUrl: string): string | null {
  let scope = $card;
  for (let i = 0; i <= 2; i++) {
    const img = scope.find('img').first();
    if (img.length) {
      const srcset = img.attr('srcset')?.split(',')[0]?.trim().split(' ')[0];
      const cand =
        img.attr('src') ??
        img.attr('data-src') ??
        img.attr('data-lazy-src') ??
        img.attr('data-original') ??
        img.attr('data-srcset') ??
        srcset;
      // ignore 1x1 tracking gifs / placeholders
      if (cand && !/data:image|placeholder|blank\.gif|loading\.gif/i.test(cand)) {
        return absUrl(cand, pageUrl);
      }
    }
    scope = scope.parent();
    if (!scope.length) break;
  }
  return null;
}

function pickPrices(
  $: cheerio.CheerioAPI,
  $card: cheerio.Cheerio<any>,
): {
  deal: number | null;
  original: number | null;
  currency: string;
} {
  const originalCandidates: number[] = [];
  $card.find(ORIGINAL_PRICE_HOST).each((_, el) => {
    originalCandidates.push(...extractAmounts(clean($(el).text())));
  });

  const dealCandidates: number[] = [];
  let currencySample = '';
  $card.find(DEAL_PRICE_HOST).each((_, el) => {
    const t = clean($(el).text());
    if (!currencySample && PRICE_TEXT.test(t)) currencySample = t;
    dealCandidates.push(...extractAmounts(t));
  });

  // Fallback: scan the whole card text when no price-ish classes exist.
  if (!dealCandidates.length) {
    const cardText = clean($card.text());
    if (PRICE_TEXT.test(cardText)) {
      dealCandidates.push(...extractAmounts(cardText));
      if (!currencySample) currencySample = cardText;
    }
  }

  const deal = dealCandidates.length ? Math.min(...dealCandidates) : null;
  const original =
    originalCandidates
      .filter((n) => deal === null || n > deal)
      .sort((a, b) => a - b)[0] ?? null;

  return { deal, original, currency: detectCurrency(currencySample) };
}

function pickDiscount($card: cheerio.Cheerio<any>): number | null {
  const m = clean($card.find(DISCOUNT_HOST).text()).match(/(\d{1,2})\s*%\s*(?:off|discount|ছাড়)?/i);
  return m ? parseInt(m[1]!, 10) : null;
}

function extractFromDom(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  site: string,
): ScrapedProduct[] {
  const cardEls = new Set<any>();
  for (const sel of CARD_SELECTORS) {
    $(sel).each((_, el) => {
      cardEls.add(el);
    });
  }

  // Last-resort fallback: anchors that wrap an image and contain a price.
  if (cardEls.size === 0) {
    $('a[href]').each((_, el) => {
      const $a = $(el);
      if ($a.find('img').length && PRICE_TEXT.test($a.text())) cardEls.add(el);
    });
  }

  // Nested selectors match containers AND their cards (e.g. .product-one >
  // .product-one__single > .product-one__single__inner). Process innermost
  // first; once a card yields a product, all its ancestors are disqualified.
  const ALL = CARD_SELECTORS.join(',');
  const ordered = [...cardEls]
    .map((el) => ({ el, inner: $(el).find(ALL).length }))
    .sort((a, b) => a.inner - b.inner);
  const blockedAncestors = new Set<any>();

  const out: ScrapedProduct[] = [];
  for (const { el } of ordered) {
    if (blockedAncestors.has(el)) continue;
    const $card = $(el);
    const title = pickTitle($, $card);
    const { deal, original, currency } = pickPrices($, $card);
    if (!title || deal === null || deal < MIN_DEAL_PRICE) continue;

    const productUrl = pickLink($card, pageUrl) ?? pageUrl;
    const discount = pickDiscount($card) ?? computeDiscount(original, deal);

    out.push({
      id: makeId(site, productUrl, title),
      title,
      originalPrice: original,
      dealPrice: deal,
      discountPercentage: discount,
      currency,
      sourceSite: site,
      productUrl,
      imageUrl: pickImage($card, pageUrl),
    });
    $(el)
      .parents()
      .each((_, p) => {
        blockedAncestors.add(p);
      });
  }
  return out;
}
