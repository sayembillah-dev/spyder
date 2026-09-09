/**
 * Cooperative cancellation for scrape jobs. When the SSE client disconnects
 * (tab closed, new search started), the request's AbortSignal fires and the
 * crawl unwinds: in-flight fetches cancel, browser contexts close, queued
 * same-host jobs skip. Cancellation is NOT a site failure — like a block,
 * it says nothing about strategy correctness, so it must never produce an
 * error report or tick the strategy cache (same Phase 4 rule as blocks).
 */
export class AbortedError extends Error {
  constructor() {
    super('Scrape cancelled — client disconnected');
    this.name = 'AbortedError';
  }
}

/** Cheap checkpoint placed before expensive units of work. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError();
}
