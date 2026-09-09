/**
 * Fixture capture — npm run fixture:capture -w server -- <url> <name>
 *
 * Renders a live page with the real detection pipeline (cheap fetch first,
 * headless Chromium when the page needs JS), then writes BOTH files into
 * test/fixtures/:
 *   <name>.html           the exact HTML the extractor saw
 *   <name>.expected.json  the current extraction output
 *
 * ⚠️  REVIEW the generated JSON by hand before committing — the snapshot IS
 * the specification. Never commit an unreviewed capture.
 */
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { detectRenderingType } from '../src/services/detector';
import { extractProductsFromHtml } from '../src/services/extractor';
import { siteNameFromUrl } from '../src/utils/sites';
import { browserHeaders, randomUserAgent } from '../src/utils/userAgents';

const [url, name] = process.argv.slice(2);
if (!url || !name || !/^[a-z0-9-]+$/.test(name)) {
  console.error('usage: npm run fixture:capture -w server -- <url> <name[a-z0-9-]>');
  process.exit(1);
}

const renderWithBrowser = async (target: string): Promise<string> => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent: randomUserAgent(),
      extraHTTPHeaders: browserHeaders(),
    });
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(5_000); // let hydration settle — mirrors csrScraper's boot wait
    return await page.content();
  } finally {
    await browser.close();
  }
};

const detection = await detectRenderingType(url).catch(() => null);
const html =
  detection && detection.renderType === 'SSR' ? detection.html : await renderWithBrowser(url);

const site = siteNameFromUrl(url);
const products = extractProductsFromHtml(html, url, site).map(({ id, ...p }) => ({ ...p }));

writeFileSync(`test/fixtures/${name}.html`, html);
writeFileSync(`test/fixtures/${name}.expected.json`, JSON.stringify(products, null, 2) + '\n');

console.log(`✅ captured ${name}: ${products.length} products (${detection?.renderType ?? 'CSR'} render)`);
console.log('   → review test/fixtures/%s.expected.json before committing it.', name);
