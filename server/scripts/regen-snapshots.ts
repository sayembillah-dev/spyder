import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extractProductsFromHtml } from '../src/services/extractor';

const dir = 'test/fixtures';
for (const f of readdirSync(dir).filter((x) => x.endsWith('.html'))) {
  const html = readFileSync(`${dir}/${f}`, 'utf8');
  const site = f.replace(/\.html$/, '');
  const base = `https://${site}.test/`;
  const out = extractProductsFromHtml(html, base, site).map(({ id, ...p }) => ({ ...p }));
  writeFileSync(`${dir}/${f.replace(/\.html$/, '.expected.json')}`, JSON.stringify(out, null, 2) + '\n');
  console.log(`${f}: ${out.length} products`);
  for (const p of out) console.log(`   ${p.title} | deal=${p.dealPrice} orig=${p.originalPrice} disc=${p.discountPercentage} cur=${p.currency} img=${p.imageUrl ? 'y' : 'n'} url=${p.productUrl}`);
}
