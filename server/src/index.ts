import cors from 'cors';
import express from 'express';
import { scrapeUrls } from './services/scraperService';
import { normalizeUrl } from './utils/sites';
import { assertPublicUrl, BlockedTargetError } from './utils/ssrf';
import { config } from './config';

const app = express();
app.use(cors());
app.use(express.json({ limit: '128kb' }));

const MAX_URLS = config.maxUrls;

if (config.allowPrivateTargets) {
  console.warn('⚠️  ALLOW_PRIVATE_TARGETS=true — SSRF guard disabled. Dev only, never deploy this.');
}

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

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'flash-deal-api', ts: Date.now() });
});

/** One-shot scrape — waits for all sites, returns the full normalized result. */
app.post('/api/scrape', async (req, res) => {
  const urls = Array.isArray(req.body?.urls)
    ? (req.body.urls as unknown[]).filter((u): u is string => typeof u === 'string')
    : [];
  if (!urls.length) {
    res.status(400).json({ error: 'Body must be { "urls": string[] }' });
    return;
  }
  // A disconnected client must cancel the crawl — not leave Chromium
  // working for an audience that's gone. (res 'close' fires on both
  // disconnect and end; writableEnded tells them apart.)
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  try {
    const bad = await validateTargets(urls.slice(0, MAX_URLS));
    if (bad) {
      res.status(400).json({ error: bad });
      return;
    }
    res.json(await scrapeUrls(urls.slice(0, MAX_URLS), () => {}, ac.signal));
  } catch (e) {
    if (ac.signal.aborted) return; // cancelled — nobody left to tell
    res.status(500).json({ error: e instanceof Error ? e.message : 'Scrape failed' });
  }
});

/** Live scrape — streams per-site progress over Server-Sent Events. */
app.get('/api/scrape/stream', async (req, res) => {
  let urls: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(req.query.urls ?? '[]'));
    if (Array.isArray(parsed)) urls = parsed.filter((u): u is string => typeof u === 'string');
  } catch {
    /* handled below */
  }
  if (!urls.length) {
    res.status(400).json({ error: 'Query param ?urls=["https://…"] (JSON array) required' });
    return;
  }
  const bad = await validateTargets(urls.slice(0, MAX_URLS)).catch(() => 'Validation failed');
  if (bad) {
    res.status(400).json({ error: bad });
    return;
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
    const result = await scrapeUrls(urls.slice(0, MAX_URLS), (e) => send('site-status', e), ac.signal);
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

app.listen(config.port, () =>
  console.log(`⚡ flash-deal api ready → http://localhost:${config.port}`),
);
