import type { ScrapeResult, SiteStatusEvent } from './types';

export interface StreamHandlers {
  onStatus: (e: SiteStatusEvent) => void;
  onDone: (r: ScrapeResult) => void;
  onError: (message: string) => void;
}

/**
 * Subscribe to the live scrape stream. Returns an unsubscribe function.
 * Events: 'site-status' (progress), 'done' (full result), 'app-error' (fatal).
 */
export function streamScrape(urls: string[], h: StreamHandlers): () => void {
  const es = new EventSource(`/api/scrape/stream?urls=${encodeURIComponent(JSON.stringify(urls))}`);

  es.addEventListener('site-status', (ev) => h.onStatus(JSON.parse((ev as MessageEvent).data)));
  es.addEventListener('done', (ev) => {
    h.onDone(JSON.parse((ev as MessageEvent).data));
    es.close();
  });
  es.addEventListener('app-error', (ev) => {
    h.onError(JSON.parse((ev as MessageEvent).data).error ?? 'Scrape failed');
    es.close();
  });
  es.onerror = () => {
    h.onError('Lost connection to the scraper API — is the server running on :4000?');
    es.close();
  };

  return () => es.close();
}
