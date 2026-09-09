import cors from 'cors';
import express from 'express';
import { scrapeUrls } from './services/scraperService';

const app = express();
app.use(cors());
app.use(express.json({ limit: '128kb' }));

const MAX_URLS = 10;

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
  try {
    res.json(await scrapeUrls(urls.slice(0, MAX_URLS)));
  } catch (e) {
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

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

  try {
    const result = await scrapeUrls(urls.slice(0, MAX_URLS), (e) => send('site-status', e));
    send('done', result);
  } catch (e) {
    send('app-error', { error: e instanceof Error ? e.message : 'Scrape failed' });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`⚡ flash-deal api ready → http://localhost:${port}`));
