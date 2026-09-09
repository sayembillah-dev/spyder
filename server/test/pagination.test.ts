import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { findNextPageUrl } from '../src/services/pagination';

const BASE = 'https://shop.test/list';

describe('findNextPageUrl', () => {
  it('prefers <a rel="next"> over everything else', () => {
    const html = `
      <a rel="next" href="/list?page=2">Next</a>
      <div class="pagination"><a href="/list?page=3">3</a></div>`;
    expect(findNextPageUrl(html, BASE)).toBe('https://shop.test/list?page=2');
  });

  it('finds a next-caption link inside pagination containers', () => {
    const html = `<div class="pagination">
      <a href="/list?page=1">1</a>
      <a href="/list?page=2">Next ›</a>
    </div>`;
    expect(findNextPageUrl(html, BASE)).toBe('https://shop.test/list?page=2');
  });

  it('recognises Bengali next captions', () => {
    const html = `<nav><a href="/list?page=2">পরবর্তী</a></nav>`;
    expect(findNextPageUrl(html, BASE)).toBe('https://shop.test/list?page=2');
  });

  it('falls back to the incremented ?page=N param', () => {
    const html = `<div class="pagination">
      <a href="/list?page=1">1</a><a href="/list?page=2">2</a><a href="/list?page=3">3</a>
    </div>`;
    expect(findNextPageUrl(html, 'https://shop.test/list?page=1')).toBe(
      'https://shop.test/list?page=2',
    );
  });

  it('falls back to /page/N/ path increments', () => {
    const html = `<div class="pagination">
      <a href="/list/page/2/">2</a>
    </div>`;
    expect(findNextPageUrl(html, 'https://shop.test/list/page/1/')).toBe(
      'https://shop.test/list/page/2/',
    );
  });

  it('treats a disabled next-caption as "last page" and suppresses the numeric fallback', () => {
    const html = `<div class="pagination">
      <a href="/list?page=1">1</a>
      <span class="disabled">Next</span>
      <a href="/list?page=2">2</a>
    </div>`;
    expect(findNextPageUrl(html, BASE)).toBeNull();
  });

  it('follows a navigable link even when aria-disabled is sloppily set (Othoba case)', () => {
    const html = `<div class="pagination">
      <a href="/list?page=2" aria-disabled="true">Next</a>
    </div>`;
    expect(findNextPageUrl(html, BASE)).toBe('https://shop.test/list?page=2');
  });

  it('treats aria-disabled as disabling when the href is a dead "#"', () => {
    const html = `<div class="pagination">
      <a href="#" aria-disabled="true">Next</a>
      <a href="/list?page=2">2</a>
    </div>`;
    expect(findNextPageUrl(html, BASE)).toBeNull();
  });

  it('returns null when there is no next page at all', () => {
    const html = `<div class="pagination"><a href="/list?page=1">1</a></div>`;
    expect(findNextPageUrl(html, 'https://shop.test/list?page=1')).toBeNull();
  });

  it('never returns the current URL', () => {
    const html = `<a rel="next" href="https://shop.test/list">Next</a>`;
    expect(findNextPageUrl(html, BASE)).toBeNull();
  });

  it('ignores javascript: hrefs', () => {
    const html = `<div class="pagination"><a href="javascript:void(0)">Next</a></div>`;
    expect(findNextPageUrl(html, BASE)).toBeNull();
  });
});

describe('findNextPageUrl on the chaldal fixture', () => {
  it('resolves rel="next"', () => {
    const html = readFileSync('test/fixtures/chaldal-popular.html', 'utf8');
    expect(findNextPageUrl(html, 'https://chaldal.test/popular')).toBe(
      'https://chaldal.test/popular?page=2',
    );
  });
});
