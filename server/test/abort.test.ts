import { describe, expect, it } from 'vitest';
import { AbortedError, throwIfAborted } from '../src/utils/abort';
import { scrapeUrls } from '../src/services/scraperService';

/**
 * Phase 6 cancellation contract: a disconnected client's AbortSignal unwinds
 * the crawl — AbortedError propagates out of scrapeUrls and is never turned
 * into a per-site error report or a strategy-cache failure tick (same rule
 * as blocks: cancellation says nothing about strategy correctness).
 */
describe('throwIfAborted', () => {
  it('does nothing without a signal or on a live one', () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });

  it('throws AbortedError on an aborted signal', () => {
    expect(() => throwIfAborted(AbortSignal.abort())).toThrow(AbortedError);
    expect(() => throwIfAborted(AbortSignal.abort())).toThrow(/cancelled/);
  });
});

describe('scrapeUrls cancellation', () => {
  it('rejects immediately on an already-aborted signal — no network touched', async () => {
    await expect(
      scrapeUrls(['https://example.com/deals'], () => {}, AbortSignal.abort()),
    ).rejects.toBeInstanceOf(AbortedError);
  });

  it('rejects for every URL when the signal is pre-aborted', async () => {
    await expect(
      scrapeUrls(
        ['https://a-shop.example/one', 'https://b-shop.example/two'],
        () => {},
        AbortSignal.abort(),
      ),
    ).rejects.toBeInstanceOf(AbortedError);
  });
});
