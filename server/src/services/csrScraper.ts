import { Configuration, PlaywrightCrawler } from 'crawlee';
import type { Page } from 'playwright';
import { browserHeaders, randomUserAgent } from '../utils/userAgents';
import { extractProductsFromHtml } from './extractor';
import type { ScrapedProduct } from '../types';

const NAV_TIMEOUT_SECS = 45;
const HANDLER_TIMEOUT_SECS = 120;
const SCROLL_ROUNDS = 14;

/** Selectors we wait for before scrolling — any hit means the app booted. */
const WAIT_SELECTORS = [
  '[class*="product" i]',
  '[data-product]',
  '[itemtype*="Product"]',
  'main',
  '#root > *',
  '#app > *',
];

async function waitForAnySelector(page: Page, selectors: string[], timeoutMs: number): Promise<string | null> {
  return Promise.any(
    selectors.map((s) =>
      page.waitForSelector(s, { timeout: timeoutMs, state: 'attached' }).then(() => s),
    ),
  ).catch(() => null);
}

/** Scroll to the bottom in steps to trigger lazy-loaded deal cards. */
async function autoScroll(page: Page): Promise<void> {
  let lastHeight = 0;
  let stableRounds = 0;
  for (let i = 0; i < SCROLL_ROUNDS; i++) {
    const height: number = await page.evaluate(() => document.body?.scrollHeight ?? 0);
    if (height === lastHeight) {
      stableRounds += 1;
      if (stableRounds >= 2) break;
    } else {
      stableRounds = 0;
    }
    lastHeight = height;
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 1.4)));
    await page.waitForTimeout(650);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * Scrape a client-rendered page: launch headless Chromium with a random
 * User-Agent, wait for the app to boot, scroll to trigger lazy loading,
 * then run the same unified extractor over the rendered DOM.
 */
export async function scrapeCsrSite(url: string, site: string): Promise<ScrapedProduct[]> {
  const userAgent = randomUserAgent();
  let products: ScrapedProduct[] = [];
  let failure: string | null = null;

  const crawler = new PlaywrightCrawler(
    {
      maxRequestsPerCrawl: 1,
      maxRequestRetries: 1,
      navigationTimeoutSecs: NAV_TIMEOUT_SECS,
      requestHandlerTimeoutSecs: HANDLER_TIMEOUT_SECS,
      launchContext: {
        launchOptions: { headless: true },
        userAgent, // every browser context gets a fresh random UA
      },
      preNavigationHooks: [
        async ({ page }) => {
          await page.setViewportSize({
            width: 1280 + Math.floor(Math.random() * 320),
            height: 760 + Math.floor(Math.random() * 200),
          });
          await page.setExtraHTTPHeaders(browserHeaders(userAgent));
          // fonts & media are pure bandwidth for scraping — block them
          await page.route('**/*.{woff,woff2,ttf,otf,eot,mp4,webm,mp3,wav}', (route) =>
            route.abort(),
          );
        },
      ],
      async requestHandler({ page, request }) {
        await page.waitForLoadState('domcontentloaded');
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
        await waitForAnySelector(page, WAIT_SELECTORS, 15_000);
        await autoScroll(page);
        await page.waitForTimeout(800); // let lazy images attach real srcs
        const html = await page.content();
        products = extractProductsFromHtml(html, request.url, site);
      },
      failedRequestHandler({ request }) {
        failure = request.errorMessages?.at(-1) ?? 'navigation failed';
      },
    },
    new Configuration({ persistStorage: false }), // memory storage — no disk litter
  );

  await crawler.run([url]);

  if (!products.length && failure) throw new Error(failure);
  return products;
}
