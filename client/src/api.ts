import type {
  DealPageRecord,
  DiscoveryReport,
  DiscoveryRequestOptions,
  RegistryAddResult,
  RegistryImportResult,
  RegistryRefreshResult,
  RegistryStatus,
  RegistryTickResult,
  ScrapeResult,
  SiteStatusEvent,
} from './types';

export interface StreamHandlers {
  onStatus: (e: SiteStatusEvent) => void;
  onDone: (r: ScrapeResult) => void;
  onError: (message: string) => void;
  /** One per domain, as its discovery completes (D7.2). */
  onDiscovery?: (r: DiscoveryReport) => void;
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
 * Events: 'site-status' (progress), 'discovery' (per-domain report),
 * 'done' (full result), 'app-error' (fatal).
 *
 * `targets` are domains OR deal-page URLs — a bare domain triggers discovery
 * server-side (mode 'auto'). An EMPTY array means "scrape my saved list":
 * the server substitutes the registry's active+pinned pages.
 *
 * Reconnect: on a transport hiccup EventSource auto-retries at the server's
 * `retry:` interval, so a blip no longer loses a 4-minute scrape. Only
 * MAX_RECONNECT_ATTEMPTS consecutive failures are fatal. A reconnect
 * re-runs the scrape server-side — the strategy cache makes re-runs cheap.
 *
 * Cancellation: closing the EventSource drops the TCP connection; the
 * server listens for it and aborts the crawl — no orphaned Chromium work.
 */
export function streamScrape(
  targets: string[],
  h: StreamHandlers,
  discovery?: DiscoveryRequestOptions,
): () => void {
  const params = new URLSearchParams({ targets: JSON.stringify(targets) });
  if (discovery && Object.keys(discovery).length) {
    params.set('discovery', JSON.stringify(discovery));
  }
  const es = new EventSource(`/api/scrape/stream?${params}`);
  let consecutiveErrors = 0;
  let settled = false; // terminal frame seen or unsubscribed — ignore late errors

  es.addEventListener('site-status', (ev) => {
    consecutiveErrors = 0; // data is flowing — connection is healthy
    const e = parseEvent<SiteStatusEvent>(ev);
    if (e) h.onStatus(e);
  });
  es.addEventListener('discovery', (ev) => {
    consecutiveErrors = 0;
    const r = parseEvent<DiscoveryReport>(ev);
    if (r) h.onDiscovery?.(r);
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

/* ── Registry API (server/src/api/registryRoutes.ts) ───────────────────── */

/** Read the server's { error } envelope out of a non-2xx response. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    /* non-JSON error body */
  }
  return `${res.status} ${res.statusText}`;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(await errorMessage(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export interface RegistryQuery {
  domain?: string;
  status?: RegistryStatus[]; // sent csv
  sort?: 'nextCheckAt' | 'lastVerifiedAt' | 'dealDensity' | 'finalScore' | 'domain';
  limit?: number;
}

export function registryList(
  q: RegistryQuery = {},
): Promise<{ records: DealPageRecord[]; total: number }> {
  const params = new URLSearchParams();
  if (q.domain) params.set('domain', q.domain);
  if (q.status?.length) params.set('status', q.status.join(','));
  if (q.sort) params.set('sort', q.sort);
  if (q.limit) params.set('limit', String(q.limit));
  const qs = params.toString();
  return req(`/api/registry${qs ? `?${qs}` : ''}`);
}

export interface RegistryAddOutcome {
  ok: boolean;
  status: number;
  record?: DealPageRecord;
  verification?: import('./types').VerificationResult;
  existed?: boolean;
  error?: string;
}

/**
 * Add-by-hand. The server VERIFIES before saving, so a refusal (400) is a
 * normal outcome, not an exception — return the verdict either way so the
 * UI can show "12 products, 3% discounted ❌ no-discounts" next to the form.
 */
export async function registryAdd(
  url: string,
  label?: string,
  notes?: string,
): Promise<RegistryAddOutcome> {
  const res = await fetch(
    '/api/registry',
    jsonInit('POST', { url, ...(label ? { label } : {}), ...(notes ? { notes } : {}) }),
  );
  const body = (await res.json().catch(() => ({}))) as Partial<RegistryAddResult> & {
    error?: string;
  };
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `${res.status} ${res.statusText}`,
      verification: body.verification,
    };
  }
  return {
    ok: true,
    status: res.status,
    record: body.record,
    verification: body.verification,
    existed: body.existed,
  };
}

export function registryPatch(
  id: string,
  patch: {
    status?: 'pinned' | 'excluded' | 'active';
    label?: string | null;
    notes?: string | null;
    nextCheckAt?: number;
  },
): Promise<{ record: DealPageRecord }> {
  return req(`/api/registry/${id}`, jsonInit('PATCH', patch));
}

export function registryDelete(id: string): Promise<void> {
  return req(`/api/registry/${id}`, { method: 'DELETE' });
}

export function registryRefresh(id: string): Promise<RegistryRefreshResult> {
  return req(`/api/registry/${id}/refresh`, { method: 'POST' });
}

export function registryRefreshAll(): Promise<RegistryTickResult> {
  return req('/api/registry/refresh', { method: 'POST' });
}

/** Export is a file download — hand the URL to an anchor, no fetch needed. */
export function registryExportUrl(format: 'json' | 'csv'): string {
  return `/api/registry/export?format=${format}`;
}

/** Accepts the export shape (bare array) or a wrapped { records } object. */
export function registryImport(payload: unknown): Promise<RegistryImportResult> {
  const records = Array.isArray(payload)
    ? payload
    : (payload as { records?: unknown[] })?.records;
  return req('/api/registry/import', jsonInit('POST', { records: records ?? [] }));
}
