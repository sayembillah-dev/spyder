import type { ScrapeResult, SiteStatusEvent } from './types';

export interface StreamHandlers {
  onStatus: (e: SiteStatusEvent) => void;
  onDone: (r: ScrapeResult) => void;
  onError: (message: string) => void;
}

/**
 * Transport drops tolerated before declaring fatal. EventSource re-connects
 * natively using the server's `retry: 3000` interval — we only count
 * consecutive failures; we never re-create the connection ourselves.
 */
const MAX_RECONNECT_ATTEMPTS = 3;

/** A single corrupt frame must not kill the whole stream. */
function parseEvent<T>(ev: Event): T | null {
  try {
    return JSON.parse((ev as MessageEvent).data) as T;
  } catch {
    return null;
  }
}

/**
 * Subscribe to the live scrape stream. Returns an unsubscribe function.
 * Events: 'site-status' (progress), 'done' (full result), 'app-error' (fatal).
 *
 * Reconnect: on a transport hiccup EventSource auto-retries at the server's
 * `retry:` interval, so a blip no longer loses a 4-minute scrape. Only
 * MAX_RECONNECT_ATTEMPTS consecutive failures are fatal. A reconnect
 * re-runs the scrape server-side — the strategy cache makes re-runs cheap.
 *
 * Cancellation: closing the EventSource drops the TCP connection; the
 * server listens for it and aborts the crawl — no orphaned Chromium work.
 */
export function streamScrape(urls: string[], h: StreamHandlers): () => void {
  const es = new EventSource(`/api/scrape/stream?urls=${encodeURIComponent(JSON.stringify(urls))}`);
  let consecutiveErrors = 0;
  let settled = false; // terminal frame seen or unsubscribed — ignore late errors

  es.addEventListener('site-status', (ev) => {
    consecutiveErrors = 0; // data is flowing — connection is healthy
    const e = parseEvent<SiteStatusEvent>(ev);
    if (e) h.onStatus(e);
  });
  es.addEventListener('done', (ev) => {
    settled = true;
    es.close();
    const r = parseEvent<ScrapeResult>(ev);
    if (r) h.onDone(r);
    else h.onError('Received a corrupt result from the server.');
  });
  es.addEventListener('app-error', (ev) => {
    settled = true;
    es.close();
    const e = parseEvent<{ error?: string }>(ev);
    h.onError(e?.error ?? 'Scrape failed');
  });
  es.onerror = () => {
    if (settled) return;
    if (es.readyState === EventSource.CLOSED) {
      // Initial connect failed (server down?) — EventSource won't retry this.
      settled = true;
      h.onError('Lost connection to the scraper API — is the server running on :4000?');
      return;
    }
    // CONNECTING: auto-reconnect in progress at the server's retry interval.
    consecutiveErrors += 1;
    if (consecutiveErrors >= MAX_RECONNECT_ATTEMPTS) {
      settled = true;
      es.close();
      h.onError(
        `Connection to the scraper API keeps dropping — gave up after ${MAX_RECONNECT_ATTEMPTS} attempts.`,
      );
    }
  };

  return () => {
    settled = true;
    es.close();
  };
}
