import cors from 'cors';
import express from 'express';
import type { Request, Response } from 'express';
import { scrapeUrls } from './services/scraperService';
import type { ScrapeRequestOptions } from './services/scraperService';
import { discoverDealPages } from './discovery';
import * as registry from './discovery/registry';
import { registryRoutes } from './api/registryRoutes';
import { normalizeUrl } from './utils/sites';
import { assertPublicUrl, BlockedTargetError } from './utils/ssrf';
import { config } from './config';
import type { DiscoveryRequestOptions } from './types';

const MAX_URLS = config.maxUrls;

/**
 * Up-front SSRF validation: a bad target is a 400, not a 500 mid-scrape.
 * Re-validated at fetch time and at the browser network layer — this first
 * pass exists to fail fast and cheaply.
 */
async function validateTargets(urls: string[]): Promise<string | null> {
  for (const raw of urls) {
    const normalized = normalizeUrl(raw);
    if (!normalized) return `Invalid URL: ${raw}`;
    try {
      await assertPublicUrl(normalized);
    } catch (e) {
      if (e instanceof BlockedTargetError) return `${e.message} (in "${raw}")`;
      throw e;
    }
  }
  return null;
}

/* ── D7.1 request shape ─────────────────────────────────────────────── */

const parseStringArray = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((u): u is string => typeof u === 'string') : [];

/** Validate + normalize the discovery options object. Returns an error
 *  string on invalid input — a typo'd knob is a 400, not a silent default. */
function sanitizeDiscovery(raw: unknown): DiscoveryRequestOptions | string {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return '"discovery" must be an object';
  const o = raw as Record<string, unknown>;
  const out: DiscoveryRequestOptions = {};

  if (o.enabled !== undefined) {
    if (o.enabled !== 'auto' && o.enabled !== 'always' && o.enabled !== 'never') {
      return "discovery.enabled must be 'auto' | 'always' | 'never'";
    }
    out.enabled = o.enabled;
  }
  if (o.maxScrape !== undefined) {
    const n = Number(o.maxScrape);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      return 'discovery.maxScrape must be an integer 1..10';
    }
    out.maxScrape = n;
  }
  if (o.minDiscountPercent !== undefined) {
    const n = Number(o.minDiscountPercent);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return 'discovery.minDiscountPercent must be between 0 and 100';
    }
    out.minDiscountPercent = n;
  }
  for (const key of ['include', 'exclude'] as const) {
    if (o[key] !== undefined) {
      const arr = o[key];
      if (
        !Array.isArray(arr) ||
        arr.length > 50 ||
        arr.some((p) => typeof p !== 'string' || !p.trim() || p.length > 200)
      ) {
        return `discovery.${key} must be an array of ≤50 patterns (≤200 chars each)`;
      }
      out[key] = arr as string[];
    }
  }
  return out;
}

/** Resolve the effective target list: explicit targets, else every active +
 *  pinned registry record — "scrape my saved list" (D7.1). */
function resolveTargets(targets: string[]): { urls: string[]; fromSavedList: boolean } | string {
  if (targets.length) return { urls: targets, fromSavedList: false };
  const saved = registry.scrapeable().map((r) => r.url);
  if (!saved.length) {
    return 'No targets given and the saved list is empty — run a discovery (targets: ["chaldal.com"]) or add pages via POST /api/registry first.';
  }
  return { urls: saved, fromSavedList: true };
}

const disconnectSignal = (res: Response): AbortSignal => {
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  return ac.signal;
};

export function createApp() {
  const app = express();
  app.use(cors());
  // Registry imports can carry thousands of records — parse that ONE route
  // with a generous limit first; body-parser skips req's already parsed.
  app.use('/api/registry/import', express.json({ limit: '8mb' }));
  app.use(express.json({ limit: '128kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'flash-deal-api', ts: Date.now() });
  });

  /** One-shot scrape — waits for all sites, returns the full normalized
   *  result. `targets` accepts bare domains (discovery runs); legacy
   *  `urls` keeps working exactly as before; an empty list scrapes the
   *  saved registry list with discovery OFF. */
  app.post('/api/scrape', async (req, res) => {
    const targets =
      req.body?.targets !== undefined ? parseStringArray(req.body.targets) : parseStringArray(req.body?.urls);
    const discovery = sanitizeDiscovery(req.body?.discovery);
    if (typeof discovery === 'string') {
      res.status(400).json({ error: discovery });
      return;
    }
    const resolved = resolveTargets(targets);
    if (typeof resolved === 'string') {
      res.status(400).json({ error: resolved });
      return;
    }
    const signal = disconnectSignal(res);
    try {
      // Saved-list records are canonical and were validated at write time;
      // the fetch-time SSRF guard still applies inside the scraper.
      if (!resolved.fromSavedList) {
        const bad = await validateTargets(resolved.urls.slice(0, MAX_URLS));
        if (bad) {
          res.status(400).json({ error: bad });
          return;
        }
      }
      const opts: ScrapeRequestOptions = {
        // "Scrape my list" means exactly these pages — no discovery.
        discovery: resolved.fromSavedList ? { ...discovery, enabled: 'never' } : discovery,
      };
      res.json(await scrapeUrls(resolved.urls.slice(0, MAX_URLS), () => {}, signal, opts));
    } catch (e) {
      if (signal.aborted) return; // cancelled — nobody left to tell
      res.status(500).json({ error: e instanceof Error ? e.message : 'Scrape failed' });
    }
  });

  /** Live scrape — streams per-site progress over Server-Sent Events, plus
   *  one `discovery` event per domain carrying the full DiscoveryReport. */
  app.get('/api/scrape/stream', async (req, res) => {
    let targets: string[] = [];
    let discoveryRaw: unknown;
    try {
      const rawTargets = req.query.targets ?? req.query.urls;
      targets = rawTargets !== undefined ? parseStringArray(JSON.parse(String(rawTargets))) : [];
      discoveryRaw = req.query.discovery !== undefined ? JSON.parse(String(req.query.discovery)) : undefined;
    } catch {
      res.status(400).json({ error: 'Query params must be JSON: ?targets=["chaldal.com"]&discovery={"enabled":"auto"}' });
      return;
    }
    const discovery = sanitizeDiscovery(discoveryRaw);
    if (typeof discovery === 'string') {
      res.status(400).json({ error: discovery });
      return;
    }
    const resolved = resolveTargets(targets);
    if (typeof resolved === 'string') {
      res.status(400).json({ error: resolved });
      return;
    }
    if (!resolved.fromSavedList) {
      const bad = await validateTargets(resolved.urls.slice(0, MAX_URLS)).catch(() => 'Validation failed');
      if (bad) {
        res.status(400).json({ error: bad });
        return;
      }
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    // Closing the stream (tab closed, new search started) aborts the crawl
    // itself — otherwise the server keeps driving Chromium for up to
    // HANDLER_TIMEOUT_SECS for nobody.
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });

    const send = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15_000);

    try {
      const result = await scrapeUrls(
        resolved.urls.slice(0, MAX_URLS),
        (e) => send('site-status', e),
        ac.signal,
        {
          discovery: resolved.fromSavedList ? { ...discovery, enabled: 'never' } : discovery,
          onDiscovery: (r) => send('discovery', r),
        },
      );
      send('done', result);
    } catch (e) {
      // A cancelled crawl owes nobody an error frame — the audience is gone.
      if (!ac.signal.aborted) {
        send('app-error', { error: e instanceof Error ? e.message : 'Scrape failed' });
      }
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });

  /** GET /api/discover?domain=… — discovery only, no scrape. The ranked
   *  candidate list (with reject reasons) without paying for a crawl. */
  app.get('/api/discover', async (req: Request, res: Response) => {
    const raw = String(req.query.domain ?? '');
    const rootUrl = raw ? normalizeUrl(raw) : null;
    if (!rootUrl) {
      res.status(400).json({ error: 'Query param ?domain=… required (bare domain or URL)' });
      return;
    }
    try {
      await assertPublicUrl(rootUrl);
    } catch (e) {
      if (e instanceof BlockedTargetError) {
        res.status(400).json({ error: e.message });
        return;
      }
      throw e;
    }
    const discovery = sanitizeDiscovery({
      maxScrape: req.query.maxScrape,
      include: req.query.include ? String(req.query.include).split(',') : undefined,
      exclude: req.query.exclude ? String(req.query.exclude).split(',') : undefined,
    });
    if (typeof discovery === 'string') {
      res.status(400).json({ error: discovery });
      return;
    }
    const signal = disconnectSignal(res);
    try {
      const outcome = await discoverDealPages(
        rootUrl,
        {
          include: discovery.include,
          exclude: discovery.exclude,
          limits: discovery.maxScrape ? { maxScrape: discovery.maxScrape } : undefined,
        },
        signal,
      );
      res.json(outcome.report);
    } catch (e) {
      if (signal.aborted) return;
      res.status(500).json({ error: e instanceof Error ? e.message : 'Discovery failed' });
    }
  });

  /** D7.3 — the saved list as a first-class resource. */
  app.use('/api/registry', registryRoutes);

  return app;
}
