import * as cheerio from 'cheerio';
import {
  computeDiscount,
  detectCurrency,
  extractAmounts,
  makeId,
  normalizeDigits,
  parsePrice,
} from '../utils/price';
import { ProductMerger } from '../utils/merge';
import { config } from '../config';
import type { ScrapedProduct } from '../types';

/** Per page-state cap — multi-state scrapes (load-more/pagination) merge
 *  several states, so listings can legitimately exceed the old 80 cap.
 *  Must be ≥ caps.total (see config.ts). */
const MAX_PRODUCTS_PER_SITE = config.caps.perState;
/** Anything below this is a stray number (quantity, index), not a price. */
const MIN_DEAL_PRICE = 10;

/* ------------------------------------------------------------------ */
/* Selector banks — generic on purpose; add site-specific ones here.   */
/* ------------------------------------------------------------------ */

export const CARD_SELECTORS = [
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
  'del, s, strike, [class*="old"], [class*="Old"], [class*="regular"], [class*="Regular"], [class*="mrp"], [class*="MRP"], [class*="compare"], [class*="was"], [class*="Was"], [class*="origin"], [class*="Origin"], [class*="discounted"] [class*="price"], [style*="line-through"], [class*="line-through"]';
const DEAL_PRICE_HOST =
  '[class*="price"], [class*="Price"], [class*="amount"], [class*="Amount"], [class*="sale"], [class*="Sale"], [class*="offer"], [class*="Offer"], ins';
const DISCOUNT_HOST =
  '[class*="discount"], [class*="Discount"], [class*="off"], [class*="Off"], [class*="badge"], [class*="Badge"]';

const PRICE_TEXT = /(?:৳|Tk\.?|BDT|Rs\.?|INR|RM|AED|\$|€|£|₹|₨)\s*[\d,]{2,}/i;

/**
 * Currency-anchored price capture. extractAmounts() alone also pulls BARE
 * digits — model numbers ("Hoco EQ27"), sizes ("20mm") and piece counts
 * ("12 Pcs") that sit next to the price inside sale-classed wrappers and
 * poison Math.min(). Anchoring to a currency marker is the universal signal
 * that a number is actually a price. Bangla digits normalized first.
 */
const ANCHORED_PRICE_RE =
  /(?:৳|Tk\.?|BDT|Rs\.?|INR|RM|Rp|AED|SAR|USD|EUR|GBP|kr|\$|€|£|₹|₨)\s*([\d,]{2,}(?:\.\d+)?)|([\d,]{2,}(?:\.\d+)?)\s*(?:৳|Tk\.?|BDT|Rs\.?|INR|RM|AED|SAR|USD|EUR|GBP|kr)/i;

function extractAnchoredAmounts(raw: string): number[] {
  const text = normalizeDigits(raw);
  const re = new RegExp(ANCHORED_PRICE_RE.source, 'gi');
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const digits = m[1] ?? m[2]; // prefix ("৳1,299") or suffix ("1299 Tk") form
    const n = parseFloat(digits.replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

const HAS_CURRENCY_MARKER = /[৳$€£₹₨]|\b(?:Tk|BDT|Rs|INR|RM|Rp|AED|SAR|USD|EUR|GBP|kr)\b/i;
/** A symbol-less element is a trusted price value only when its ENTIRE text
 *  is numeric — mixed prose ("sale-title" classes holding product names)
 *  carries model/size/count digits that must never reach Math.min(). */
const BARE_NUMERIC_RE = /^[\d,.\s]+$/;

/**
 * Universal price-amount rule:
 *  ① text with a currency marker → anchored extraction (title digits can't leak)
 *  ② purely-numeric bare text → plain extraction (symbol lives in a sibling)
 *  ③ anything else → no amounts at all ("EQ27" in a sale-title is not a price)
 * Exported for the heuristic unit tests — this is the invariant the whole
 * price pipeline depends on.
 */
export function amountsFromPriceText(t: string): number[] {
  if (HAS_CURRENCY_MARKER.test(t)) return extractAnchoredAmounts(t);
  if (BARE_NUMERIC_RE.test(t)) return extractAmounts(t);
  return [];
}

/* ------------------------------------------------------------------ */
/* Public entry point — shared by the SSR path (axios HTML) and the    */
/* CSR path (Playwright's rendered page.content()).                    */
/* ------------------------------------------------------------------ */

/**
 * The extraction ladder, cheapest-truth first:
 *   ① JSON-LD          (declared, exact)
 *   ② Microdata        (declared, exact)
 *   ②b OpenGraph       (declared, exact — single-product pages)
 *   ③ Embedded JSON    (Next/Nuxt/Apollo/hydration payloads — strong, inferred shape)
 *   ④ DOM selectors    (heuristic)
 *   ⑤ Structural       (last resort — only when ①–④ all came up empty)
 *
 * Declared rungs and the DOM rung always run and merge — a JSON-LD product
 * missing an image gets it backfilled from the DOM pass. Structural
 * inference stays lazy: zero cost for every site that already works.
 */
/** Which rung of the extraction ladder produced products. */
export type ExtractionStrategyName =
  | 'json-ld'
  | 'microdata'
  | 'opengraph'
  | 'embedded-json'
  | 'dom'
  | 'structure';

export interface ExtractionDiagnostics {
  /** Every rung that produced products, in ladder order. */
  strategies: ExtractionStrategyName[];
  /** The DOM-rung selector that matched the most product-yielding cards —
   *  learned per host (Phase 4) and retried first next run. */
  matchedCardSelector: string | null;
}

export function extractProductsFromHtml(
  html: string,
  pageUrl: string,
  site: string,
  extraCardSelectors: string[] = [],
): ScrapedProduct[] {
  return extractWithDiagnostics(html, pageUrl, site, extraCardSelectors).products;
}

export function extractWithDiagnostics(
  html: string,
  pageUrl: string,
  site: string,
  extraCardSelectors: string[] = [],
): { products: ScrapedProduct[]; diagnostics: ExtractionDiagnostics } {
  const $ = cheerio.load(html);
  const rungs: Array<[ExtractionStrategyName, ScrapedProduct[]]> = [
    ['json-ld', extractFromJsonLd($, pageUrl, site)],
    ['microdata', extractFromMicrodata($, pageUrl, site)],
    ['opengraph', extractFromOpenGraph($, pageUrl, site)],
    ['embedded-json', extractFromEmbeddedJson($, pageUrl, site)],
  ];
  const declared = rungs.flatMap(([, ps]) => ps);

  const dom = extractFromDom($, pageUrl, site, extraCardSelectors);
  rungs.push(['dom', dom.products]);

  const viaStructure =
    declared.length === 0 && dom.products.length === 0
      ? extractFromStructure($, pageUrl, site)
      : [];
  rungs.push(['structure', viaStructure]);

  // One shared merger everywhere: the JSON path is strong on prices but often
  // lacks images/links, so a duplicate backfills the incumbent rather than
  // being dropped. Declared sources are added FIRST so their exact fields
  // win the incumbent slot.
  const merger = new ProductMerger(MAX_PRODUCTS_PER_SITE);
  merger.add([...declared, ...dom.products, ...viaStructure], pageUrl);

  return {
    products: merger.values(),
    diagnostics: {
      strategies: rungs.filter(([, ps]) => ps.length > 0).map(([name]) => name),
      matchedCardSelector: dom.topSelector,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Strategy ①: JSON-LD — <script type="application/ld+json">.          */
/* schema.org Product/Offer data is DECLARED, not inferred: no         */
/* currency anchoring, no Math.min guessing, no "176 Sold"             */
/* contamination possible. Emitted by Shopify, WooCommerce, Magento,   */
/* BigCommerce and every SEO plugin in existence.                      */
/* ------------------------------------------------------------------ */

/** Walk into the containers schema.org listings hide inside. */
function* iterJsonLdProducts(node: unknown, depth: number): Generator<JsonObj> {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const x of node) yield* iterJsonLdProducts(x, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as JsonObj;
  const t = obj['@type'];
  const types = (Array.isArray(t) ? t : [t]).map((x) => String(x).toLowerCase());
  if (types.includes('product')) {
    yield obj;
    return;
  }
  // ItemList→itemListElement→ListItem→item, OfferCatalog→itemListElement,
  // @graph wrappers, Offer→itemOffered, WebPage→mainEntity.
  for (const key of ['@graph', 'itemListElement', 'item', 'itemOffered', 'mainEntity', 'hasPart']) {
    if (obj[key] !== undefined) yield* iterJsonLdProducts(obj[key], depth + 1);
  }
}

/** Offers arrive as Offer | Offer[] | AggregateOffer (lowPrice/highPrice). */
function jsonLdOfferPrice(offers: unknown): { price: unknown; currency: string | null } {
  const offer = Array.isArray(offers) ? offers[0] : offers;
  if (!offer || typeof offer !== 'object') return { price: undefined, currency: null };
  const o = offer as JsonObj;
  const spec = o.priceSpecification as JsonObj | undefined;
  const price = o.price ?? o.lowPrice ?? spec?.price;
  const currencyRaw = o.priceCurrency ?? spec?.priceCurrency;
  return { price, currency: typeof currencyRaw === 'string' ? currencyRaw : null };
}

function mapJsonLdProduct(obj: JsonObj, pageUrl: string, site: string): ScrapedProduct | null {
  const title = typeof obj.name === 'string' ? clean(obj.name) : null;
  const { price, currency } = jsonLdOfferPrice(obj.offers);
  const deal = parsePrice(price);
  if (!title || title.length < 4 || deal === null || deal < MIN_DEAL_PRICE) return null;

  let imageRaw: unknown = obj.image;
  if (Array.isArray(imageRaw)) imageRaw = imageRaw[0];
  if (imageRaw && typeof imageRaw === 'object') {
    const imgObj = imageRaw as JsonObj; // ImageObject
    imageRaw = imgObj.url ?? imgObj.contentUrl;
  }

  const productUrl = absUrl(typeof obj.url === 'string' ? obj.url : null, pageUrl) ?? pageUrl;

  return {
    id: makeId(site, productUrl, title),
    title,
    originalPrice: null, // declared sources carry no strike-through; DOM backfills
    dealPrice: deal,
    discountPercentage: null,
    currency: currency?.toUpperCase() ?? detectCurrency(price),
    sourceSite: site,
    productUrl,
    imageUrl: absUrl(typeof imageRaw === 'string' ? imageRaw : null, pageUrl),
  };
}

function extractFromJsonLd(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  site: string,
): ScrapedProduct[] {
  const out: ScrapedProduct[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = ($(el).html() ?? '').trim();
    if (!raw) return;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return; // sloppy JSON in the wild — tolerate, other rungs remain
    }
    for (const prod of iterJsonLdProducts(data, 0)) {
      const p = mapJsonLdProduct(prod, pageUrl, site);
      if (p) out.push(p);
      if (out.length >= MAX_PRODUCTS_PER_SITE) return false;
    }
    return undefined;
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Strategy ②: Microdata — [itemtype*="Product"] cards carry itemprop  */
/* attributes we previously ignored (we only used the itemtype as a    */
/* card selector). Declared values beat heuristics: `content` attrs    */
/* over element text.                                                  */
/* ------------------------------------------------------------------ */

function extractFromMicrodata(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  site: string,
): ScrapedProduct[] {
  const out: ScrapedProduct[] = [];
  $('[itemtype*="Product"]').each((_, el) => {
    const $card = $(el);
    const prop = (name: string) => $card.find(`[itemprop="${name}"]`).first();
    const propVal = (name: string): string =>
      clean(prop(name).attr('content') ?? prop(name).attr('href') ?? prop(name).text());

    const title = propVal('name');
    const deal = parsePrice(propVal('price'));
    if (title.length < 4 || deal === null || deal < MIN_DEAL_PRICE) return;

    const imgEl = prop('image');
    const image =
      imgEl.attr('src') ?? imgEl.attr('content') ?? imgEl.attr('href') ?? null;

    const linkEl = prop('url');
    const productUrl =
      absUrl((linkEl.attr('href') ?? linkEl.attr('content') ?? linkEl.text()) || null, pageUrl) ??
      pageUrl;

    const currencyRaw = propVal('priceCurrency');
    out.push({
      id: makeId(site, productUrl, title),
      title,
      originalPrice: null,
      dealPrice: deal,
      discountPercentage: null,
      currency: currencyRaw ? currencyRaw.toUpperCase() : detectCurrency(propVal('price')),
      sourceSite: site,
      productUrl,
      imageUrl: absUrl(image, pageUrl),
    });
    if (out.length >= MAX_PRODUCTS_PER_SITE) return false;
    return undefined;
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Strategy ②b: OpenGraph product tags — single-product pages only.    */
/* ------------------------------------------------------------------ */

function extractFromOpenGraph(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  site: string,
): ScrapedProduct[] {
  const meta = (name: string) =>
    $(`meta[property="${name}"], meta[name="${name}"]`).first().attr('content') ?? null;
  const deal = parsePrice(meta('product:price:amount') ?? meta('og:price:amount'));
  if (deal === null || deal < MIN_DEAL_PRICE) return [];
  const title = clean(meta('og:title') ?? '');
  if (title.length < 4) return [];

  const productUrl = absUrl(meta('og:url'), pageUrl) ?? pageUrl;
  return [
    {
      id: makeId(site, productUrl, title),
      title,
      originalPrice: null,
      dealPrice: deal,
      discountPercentage: null,
      currency: (
        meta('product:price:currency') ??
        meta('og:price:currency') ??
        detectCurrency('')
      ).toUpperCase(),
      sourceSite: site,
      productUrl,
      imageUrl: absUrl(meta('og:image'), pageUrl),
    },
  ];
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

/**
 * Deep-walk any parsed JSON payload and pick out arrays of product-shaped
 * objects (≥ half the objects in an array of ≥2 look like products = a
 * product listing). Depth- and count-capped so a hostile payload can't
 * spin the walker. Exported: the browser rung feeds intercepted network
 * responses through the exact same walker (§ network interception).
 */
export function walkForProducts(
  data: unknown,
  pageUrl: string,
  site: string,
): ScrapedProduct[] {
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

/**
 * Balance-match a JSON object/array literal starting at text[start]
 * (must be '{' or '['). String- and escape-aware. Returns null when the
 * literal never closes (truncated script, non-JSON code).
 */
function balancedLiteral(text: string, start: number): string | null {
  if (text[start] !== '{' && text[start] !== '[') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse-tolerantly yield every balanced JSON literal found at each match. */
function* literalsAfter(code: string, re: RegExp): Generator<unknown> {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const rest = code.slice(m.index + m[0].length);
    const start = rest.search(/[[{]/);
    if (start === -1) continue;
    const literal = balancedLiteral(rest, start);
    if (!literal) continue;
    try {
      yield JSON.parse(literal);
    } catch {
      /* JS-but-not-JSON (unquoted keys, function calls) — tolerate */
    }
  }
}

/** Hydration globals that storefronts serialize into inline scripts. */
const HYDRATION_GLOBAL_RE =
  /(?:window\.)?__(?:NUXT|APOLLO_STATE|PRELOADED_STATE|INITIAL_STATE|INITIAL_DATA|NEXT_DATA)__\s*=\s*/g;

/** self.__next_f.push([1, "..."]) — App Router flight chunks. */
const NEXT_F_PUSH_RE = /self\.__next_f\.push\(\s*\[\s*\d+\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\s*\)/g;

/** Flight rows look like `3:{...json...}\n` — id prefix, then a literal. */
const NEXT_F_ROW_RE = /(?:^|\n)\s*[0-9a-z]+\s*:\s*(?=[{[])/gi;

/**
 * Every JSON payload a page might carry, framework-agnostic:
 *   1. declared <script type="application/json"> blocks (incl. __NEXT_DATA__)
 *   2. hydration globals: window.__NUXT__, __APOLLO_STATE__, …
 *   3. Next.js App Router flight data: self.__next_f.push([1,"..."]) chunks,
 *      concatenated, then split into per-row JSON literals
 */
function* jsonSources($: cheerio.CheerioAPI): Generator<unknown> {
  // 1. declared JSON blocks
  for (const el of $('script[type="application/json"]').toArray()) {
    const raw = ($(el).html() ?? '').trim();
    if (!raw) continue;
    try {
      yield JSON.parse(raw);
    } catch {
      /* tolerate */
    }
  }

  // 2+3. inline scripts: hydration globals and flight chunks
  for (const el of $('script:not([src])').toArray()) {
    const code = $(el).html() ?? '';
    if (!code) continue;

    // HYDRATION_GLOBAL_RE is a shared `g`-flagged regex reused across every
    // <script> in this loop; .test() advances its lastIndex on a match, so
    // without resetting it here a later, SHORTER script whose match falls
    // before that leftover offset is silently skipped (test() starts past
    // the actual match and finds nothing).
    HYDRATION_GLOBAL_RE.lastIndex = 0;
    if (HYDRATION_GLOBAL_RE.test(code)) {
      yield* literalsAfter(code, HYDRATION_GLOBAL_RE);
    }

    if (!code.includes('__next_f.push')) continue;
    NEXT_F_PUSH_RE.lastIndex = 0;
    const chunks: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = NEXT_F_PUSH_RE.exec(code)) !== null) {
      try {
        chunks.push(JSON.parse(m[1]!)); // unescape the pushed string literal
      } catch {
        /* malformed chunk — drop it, keep the rest */
      }
    }
    if (!chunks.length) continue;
    const flight = chunks.join('');
    NEXT_F_ROW_RE.lastIndex = 0;
    let row: RegExpExecArray | null;
    while ((row = NEXT_F_ROW_RE.exec(flight)) !== null) {
      const literal = balancedLiteral(flight, row.index + row[0].length);
      if (!literal) continue;
      try {
        yield JSON.parse(literal);
      } catch {
        /* flight rows can be strings or refs — only JSON objects matter */
      }
    }
  }
}

/**
 * Strategy ③: embedded JSON. __NEXT_DATA__ (Pages Router) is just one
 * application/json block; App Router streams __next_f flight payloads with
 * no __NEXT_DATA__ at all; Nuxt/Apollo/Redux hydrate via window globals.
 * One walker, every source.
 */
function extractFromEmbeddedJson(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  site: string,
): ScrapedProduct[] {
  const found: ScrapedProduct[] = [];
  const seen = new Set<string>();
  for (const source of jsonSources($)) {
    for (const p of walkForProducts(source, pageUrl, site)) {
      const key = `${p.title.toLowerCase()}|${p.dealPrice}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(p);
      if (found.length >= MAX_PRODUCTS_PER_SITE) return found;
    }
  }
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
    originalCandidates.push(...amountsFromPriceText(clean($(el).text())));
  });

  const dealCandidates: number[] = [];
  let currencySample = '';
  $card.find(DEAL_PRICE_HOST).each((_, el) => {
    // skip EMI/installment figures ("৳176/month") and sold counters
    // ("176 Sold" in Othoba's .product-price) — they poison Math.min()
    const idCls = `${$(el).attr('id') ?? ''} ${$(el).attr('class') ?? ''}`;
    if (/emi|install|sold/i.test(idCls)) return;
    const t = clean($(el).text());
    if (!currencySample && PRICE_TEXT.test(t)) currencySample = t;
    dealCandidates.push(...amountsFromPriceText(t));
  });

  // Fallback: scan the whole card text when no price-ish classes exist.
  // Clone and strip EMI/sold-counter/discount-badge blocks first — none of
  // "৳176/month", "176 Sold" or "800 TK OFF" is a deal price.
  if (!dealCandidates.length) {
    const $clone = $card.clone();
    $clone.find('[class*="emi" i], [id*="emi" i], [class*="install" i], [id*="install" i], [class*="sold" i], [id*="sold" i], [class*="discount" i], [class*="badge" i]').remove();
    const cardText = clean($clone.text());
    if (PRICE_TEXT.test(cardText)) {
      dealCandidates.push(...amountsFromPriceText(cardText));
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
  extraCardSelectors: string[] = [],
): { products: ScrapedProduct[]; topSelector: string | null } {
  // Learned host-specific selectors (Phase 4 cache) get first crack; the
  // generic bank follows.
  const selectors = [...extraCardSelectors, ...CARD_SELECTORS];
  const cardEls = new Map<any, string>(); // el → first selector that matched it
  for (const sel of selectors) {
    let matched: cheerio.Cheerio<any>;
    try {
      matched = $(sel);
    } catch {
      continue; // a learned selector that no longer parses — ignore it
    }
    matched.each((_, el) => {
      if (!cardEls.has(el)) cardEls.set(el, sel);
    });
  }

  // Last-resort fallback: anchors that wrap an image and contain a price.
  if (cardEls.size === 0) {
    $('a[href]').each((_, el) => {
      const $a = $(el);
      if ($a.find('img').length && PRICE_TEXT.test($a.text())) cardEls.set(el, '');
    });
  }

  // Nested selectors match containers AND their cards (e.g. .product-one >
  // .product-one__single > .product-one__single__inner). Process innermost
  // first; once a card yields a product, all its ancestors are disqualified.
  const ALL = selectors.join(',');
  const ordered = [...cardEls.keys()]
    .map((el) => ({ el, inner: $(el).find(ALL).length }))
    .sort((a, b) => a.inner - b.inner);
  const blockedAncestors = new Set<any>();

  const out: ScrapedProduct[] = [];
  const selectorWins = new Map<string, number>();
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
    const sel = cardEls.get(el);
    if (sel) selectorWins.set(sel, (selectorWins.get(sel) ?? 0) + 1);
    $(el)
      .parents()
      .each((_, p) => {
        blockedAncestors.add(p);
      });
  }

  const topSelector =
    [...selectorWins.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { products: out, topSelector };
}

/* ------------------------------------------------------------------ */
/* Strategy 3: structural inference — utility-CSS storefronts (pure    */
/* Tailwind & co.) ship ZERO semantic product markup: no .product      */
/* classes, no data-attributes, no microdata. There, a product card is */
/* INFERRED from its price: every price-shaped text leaf climbs its    */
/* ancestors until the subtree outgrows "card size"; the last          */
/* card-sized ancestor IS the card. Universal — keyed on the one thing */
/* every deal listing must show: money.                                */
/* ------------------------------------------------------------------ */

const STRUCT_PRICE = /(?:৳|Tk\.?|BDT|Rs\.?|INR|RM|Rp|AED|SAR|USD|EUR|GBP|\$|€|£|₹|₨)\s*[\d,]{2,}/i;
/** A subtree bigger than this is a section/grid, not one card. */
const STRUCT_TEXT_MAX = 400;
/** More price leaves than this = a listing container, not one product. */
const STRUCT_PRICE_MAX = 6;
const STRUCT_CLIMB_MAX = 6;
/** CTA/verb labels that must never become titles. */
const STRUCT_CTA =
  /^(buy now|add to cart|order now|shop now|quick view|view|details|checkout|কিনুন|অর্ডার করুন|বিস্তারিত|কার্ট)\.?$/i;

/** An element's own text, children excluded. */
const ownText = ($el: cheerio.Cheerio<any>): string =>
  clean(
    $el
      .contents()
      .filter((_, c) => (c as { type?: string }).type === 'text')
      .text(),
  );

const isPriceLeaf = (t: string): boolean =>
  t.length >= 3 && t.length <= 60 && STRUCT_PRICE.test(t);

/** Title for structure-inferred cards: utility-CSS cards rarely use heading
 *  tags, so take the longest non-price, non-CTA own-text inside the card. */
function pickInlineTitle($: cheerio.CheerioAPI, $card: cheerio.Cheerio<any>): string | null {
  let best: string | null = null;
  $card.find('*').each((_, el) => {
    const t = ownText($(el));
    if (t.length < 8 || t.length > 220) return;
    if (STRUCT_PRICE.test(t) || STRUCT_CTA.test(t)) return;
    if (!best || t.length > best.length) best = t;
  });
  return best;
}

function extractFromStructure(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  site: string,
): ScrapedProduct[] {
  // 1) price-shaped leaves: elements whose OWN text looks like money
  const leaves: any[] = [];
  $('body *').each((_, el) => {
    if (isPriceLeaf(ownText($(el)))) leaves.push(el);
  });
  if (leaves.length < 2) return []; // a lone price is a banner, not a listing

  // 2) climb each leaf: the last ancestor still "card-sized" is the card
  const cards = new Set<any>();
  for (const leaf of leaves) {
    let node = $(leaf);
    let card: any = null;
    for (let d = 0; d < STRUCT_CLIMB_MAX; d++) {
      const parent = node.parent();
      if (!parent.length || parent.is('body, html')) break;
      if (clean(parent.text()).length > STRUCT_TEXT_MAX) break;
      let prices = 0;
      let tooMany = false;
      parent.find('*').each((_, el) => {
        if (isPriceLeaf(ownText($(el)))) {
          prices += 1;
          if (prices > STRUCT_PRICE_MAX) {
            tooMany = true;
            return false; // early exit — cap keeps big docs cheap
          }
        }
        return undefined;
      });
      if (tooMany) break;
      card = parent.get(0);
      node = parent;
    }
    if (card && card !== leaf) cards.add(card);
  }
  if (!cards.size) return [];

  // 3) innermost-first: a card that yields a product disqualifies its
  //    ancestors (deal+original prices of one product converge to the same
  //    card; sibling products in one row must not merge into a mega-card)
  const sorted = [...cards].sort((a, b) => $(a).find('*').length - $(b).find('*').length);
  const blocked = new Set<any>();
  const out: ScrapedProduct[] = [];

  for (const el of sorted) {
    if (blocked.has(el)) continue;
    const $card = $(el);
    // cards link somewhere or show something — pure text blobs are not cards
    if (!$card.is('a') && !$card.find('img').length && !$card.find('a[href]').length) continue;

    // Prices come ONLY from price-shaped leaves — ratings ("4.5"), counts
    // and stray digits in the card text must never leak into Math.min().
    const amounts: number[] = [];
    let currencySample = '';
    $card.find('*').each((_, n) => {
      const t = ownText($(n));
      if (isPriceLeaf(t)) {
        amounts.push(...extractAnchoredAmounts(t)); // leaves are money-anchored by definition
        if (!currencySample) currencySample = t;
      }
    });
    const deal = amounts.length ? Math.min(...amounts) : null;
    if (deal === null || deal < MIN_DEAL_PRICE) continue;
    const original = amounts.filter((n) => n > deal).sort((a, b) => a - b)[0] ?? null;

    const title = pickTitle($, $card) ?? pickInlineTitle($, $card);
    if (!title) continue;

    const productUrl = pickLink($card, pageUrl) ?? pageUrl;
    const discount = pickDiscount($card) ?? computeDiscount(original, deal);

    out.push({
      id: makeId(site, productUrl, title),
      title,
      originalPrice: original,
      dealPrice: deal,
      discountPercentage: discount,
      currency: detectCurrency(currencySample),
      sourceSite: site,
      productUrl,
      imageUrl: pickImage($card, pageUrl),
    });
    $(el)
      .parents()
      .each((_, p) => {
        blocked.add(p);
      });
    if (out.length >= MAX_PRODUCTS_PER_SITE) break;
  }
  return out;
}
