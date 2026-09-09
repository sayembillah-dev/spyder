import { describe, expect, it } from 'vitest';
import { detectBlock } from '../src/utils/block';

describe('detectBlock', () => {
  it('flags 403/429 by status alone', () => {
    expect(detectBlock('', 403)).toBe('HTTP 403');
    expect(detectBlock('', 429)).toBe('HTTP 429');
  });

  it('does not flag other statuses', () => {
    expect(detectBlock('', 200)).toBeNull();
    expect(detectBlock('<html>nothing</html>', 404)).toBeNull();
  });

  it.each([
    '<title>Just a moment...</title>',
    '<h1>Checking your browser</h1>',
    '<p>Please verify you are human</p>',
    '<div id="cf-browser-verification"></div>',
    '<span>Attention Required! | Cloudflare</span>',
    'Our systems have detected unusual traffic from your network',
    '<div class="g-recaptcha">captcha</div>',
  ])('flags challenge-page copy: %s', (html) => {
    expect(detectBlock(html)).toMatch(/^challenge page/);
  });

  it('passes clean storefront HTML', () => {
    const html = `<html><body><div class="product-card"><h3>Real Product</h3>
      <span class="price">৳1,299</span></div></body></html>`;
    expect(detectBlock(html)).toBeNull();
  });

  it('only scans the first 20k chars — banners are always near the top', () => {
    const html = `${'x'.repeat(25_000)}<p>verify you are human</p>`;
    expect(detectBlock(html)).toBeNull();
  });
});
