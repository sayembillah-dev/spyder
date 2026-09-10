import { Router } from 'express';
import type { Request, Response } from 'express';
import { canonicalizeUrl } from '../discovery/canonicalize';
import { productFingerprint } from '../discovery/fingerprint';
import * as registry from '../discovery/registry';
import type { DealPageRecord, RegistryStatus } from '../discovery/registry';
import { guardFetch, toCheckOutcome, verifyManual } from '../services/registryRefresh';
import { scrapeUrls } from '../services/scraperService';
import { finalScore } from '../discovery/verify';
import { normalizeUrl } from '../utils/sites';
import { config } from '../config';
import type { DealCandidate } from '../types';

/**
 * D7.3 — the saved list as a first-class resource.
 *
 * Two deliberate choices (per the plan): `excluded` is NOT `DELETE` (a
 * delete gets rediscovered next run; an exclusion is remembered), and
 * manual adds go through verification so the registry never accumulates
 * rows nothing has ever confirmed.
 */
export const registryRoutes = Router();

const ALL_STATUSES = new Set<RegistryStatus>([
  'candidate',
  'active',
  'stale',
  'parked',
  'excluded',
  'pinned',
]);
const PATCH_STATUSES = new Set(['pinned', 'excluded', 'active']);
const SORT_KEYS = new Set(['nextCheckAt', 'lastVerifiedAt', 'finalScore', 'lastSeenAt']);

/** A network-doing route owes its fetch budget to a connected client. */
function disconnectSignal(res: Response): AbortSignal {
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  return ac.signal;
}

/* ── READ ─────────────────────────────────────────────────────────── */

/** GET /api/registry?domain=&status=a,b&sort=&limit= → paginated records. */
registryRoutes.get('/', (req: Request, res: Response) => {
  registry.applyStaleness(); // the Saved Pages view should be honest
  const q: registry.RegistryQuery = {};
  if (req.query.domain) q.domain = String(req.query.domain);
  if (req.query.status) {
    const statuses = String(req.query.status)
      .split(',')
      .filter((s): s is RegistryStatus => ALL_STATUSES.has(s as RegistryStatus));
    if (!statuses.length) {
      res.status(400).json({ error: `status must be one of: ${[...ALL_STATUSES].join(', ')}` });
      return;
    }
    q.status = statuses;
  }
  if (req.query.sort) {
    const sort = String(req.query.sort);
    if (!SORT_KEYS.has(sort)) {
      res.status(400).json({ error: `sort must be one of: ${[...SORT_KEYS].join(', ')}` });
      return;
    }
    q.sort = sort as registry.RegistryQuery['sort'];
  }
  if (req.query.limit) {
    const limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      res.status(400).json({ error: 'limit must be an integer 1..500' });
      return;
    }
    q.limit = limit;
  }
  const total = registry.list({ domain: q.domain, status: q.status }).length;
  res.json({ records: registry.list(q), total });
});

/** GET /api/registry/export?format=json|csv — the whole list, portable. */
registryRoutes.get('/export', (req: Request, res: Response) => {
  if (String(req.query.format) === 'csv') {
    res
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="deal-registry.csv"')
      .send(registry.exportCsv());
    return;
  }
  res.json(registry.exportJson());
});

/* ── CREATE (verified before accepted) ────────────────────────────── */

/** POST /api/registry { url, label?, notes? } — add a URL by hand. */
registryRoutes.post('/', async (req: Request, res: Response) => {
  const rawUrl = req.body?.url;
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    res.status(400).json({ error: 'Body must be { "url": string, label?, notes? }' });
    return;
  }
  const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 200) : null;
  const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 2000) : null;

  const normalized = normalizeUrl(rawUrl);
  const canonical = normalized && canonicalizeUrl(normalized, normalized);
  if (!canonical) {
    res.status(400).json({ error: `Invalid URL: ${rawUrl}` });
    return;
  }

  const existing = registry.findByUrl(canonical);
  // A remembered "no" is not overwritten by an add — unexclude first.
  if (existing?.status === 'excluded') {
    res.status(409).json({
      error: 'This URL is excluded. PATCH it back to active first — exclusion is a remembered "no".',
      record: existing,
    });
    return;
  }
  if (existing) {
    res.json({ record: existing, existed: true });
    return;
  }

  const guardErr = await guardFetch(canonical);
  if (guardErr) {
    res.status(400).json({ error: guardErr });
    return;
  }

  const signal = disconnectSignal(res);
  let verified: Awaited<ReturnType<typeof verifyManual>>;
  try {
    verified = await verifyManual(canonical, label, signal);
  } catch (e) {
    if (signal.aborted) return;
    res.status(400).json({ error: e instanceof Error ? e.message : 'Verification fetch failed' });
    return;
  }
  const { candidate, outcome } = verified;
  const reason = outcome.verification.rejectedReason;
  let verification = outcome.verification;
  let evidence = candidate.evidence;

  if (reason === 'unverified-csr') {
    // The cheap SSR rung cannot see a CSR shell — verify through the real
    // ladder instead (one explicit, user-requested scrape of this URL).
    const scraped = await scrapeUrls([canonical], () => {}, signal, {
      discovery: { enabled: 'never' },
    });
    if (scraped.products.length < config.discovery.verify.minProducts) {
      res.status(400).json({
        error: 'unverified-csr',
        verification,
        hint: 'The page renders client-side and even a real browser found no products.',
      });
      return;
    }
    const discounted = scraped.products.filter(
      (p) => p.originalPrice !== null || (p.discountPercentage ?? 0) > 0,
    );
    const pcts = scraped.products
      .map((p) => p.discountPercentage)
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
    verification = {
      productCount: scraped.products.length,
      dealDensity: scraped.products.length ? discounted.length / scraped.products.length : 0,
      medianDiscountPct: pcts.length ? pcts[Math.floor(pcts.length / 2)]! : null,
      quality: scraped.report[0]?.quality ?? verification.quality,
      hasCountdown: false,
      renderType: 'CSR',
      productFingerprint: productFingerprint(scraped.products),
    };
    evidence = [...evidence, 'verified-via-scrape'];
  } else if (reason && reason !== 'demoted') {
    // 'demoted' = a real but thin listing — the user explicitly asked, so
    // it is accepted (scored low). Everything else rejected is a 400:
    // a bad URL is a 400, not a bad row.
    res.status(400).json({ error: reason, verification });
    return;
  }

  const record = registry.upsert({
    url: canonical,
    source: 'user',
    evidence,
    label,
    finalScore: finalScore(candidate, verification),
    verified: verification,
  });
  if (notes) registry.patch(record.id, { notes });
  res.status(201).json({ record: registry.get(record.id), verification });
});

/* ── UPDATE / DELETE ──────────────────────────────────────────────── */

/** PATCH /api/registry/:id — { status: pinned|excluded|active, label?,
 *  notes?, nextCheckAt? }. Pinning and excluding are user facts. */
registryRoutes.patch('/:id', (req: Request, res: Response) => {
  const updates: Parameters<typeof registry.patch>[1] = {};
  const body = req.body ?? {};
  if (body.status !== undefined) {
    if (!PATCH_STATUSES.has(body.status)) {
      res.status(400).json({ error: "status must be 'pinned' | 'excluded' | 'active'" });
      return;
    }
    updates.status = body.status;
  }
  if (body.label !== undefined) {
    if (body.label !== null && typeof body.label !== 'string') {
      res.status(400).json({ error: 'label must be a string or null' });
      return;
    }
    updates.label = body.label;
  }
  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== 'string') {
      res.status(400).json({ error: 'notes must be a string or null' });
      return;
    }
    updates.notes = body.notes;
  }
  if (body.nextCheckAt !== undefined) {
    const n = Number(body.nextCheckAt);
    if (!Number.isFinite(n) || n < 0) {
      res.status(400).json({ error: 'nextCheckAt must be an epoch-ms timestamp' });
      return;
    }
    updates.nextCheckAt = n;
  }
  const rec = registry.patch(req.params.id as string, updates);
  if (!rec) {
    res.status(404).json({ error: `No registry record ${req.params.id}` });
    return;
  }
  res.json({ record: rec });
});

/** DELETE /api/registry/:id — hard delete. Distinct from 'excluded'. */
registryRoutes.delete('/:id', (req: Request, res: Response) => {
  if (!registry.remove(req.params.id as string)) {
    res.status(404).json({ error: `No registry record ${req.params.id}` });
    return;
  }
  res.status(204).end();
});

/* ── REFRESH ──────────────────────────────────────────────────────── */

/** POST /api/registry/:id/refresh — verify + scrape this one page now.
 *  The user explicitly asked, so the scrape runs even when the fingerprint
 *  is unchanged (the response still reports fingerprintChanged). */
registryRoutes.post('/:id/refresh', async (req: Request, res: Response) => {
  const rec = registry.get(req.params.id as string);
  if (!rec) {
    res.status(404).json({ error: `No registry record ${req.params.id}` });
    return;
  }
  const guardErr = await guardFetch(rec.url);
  if (guardErr) {
    res.status(400).json({ error: guardErr });
    return;
  }
  const signal = disconnectSignal(res);
  try {
    const { outcome } = await verifyManual(rec.url, rec.label, signal);
    const check = toCheckOutcome(rec, outcome.verification);
    registry.recordCheck(rec.id, check);
    const scrape = outcome.verification.rejectedReason
      ? null
      : await scrapeUrls([rec.url], () => {}, signal, { discovery: { enabled: 'never' } });
    res.json({
      record: registry.get(rec.id),
      verification: outcome.verification,
      fingerprintChanged: check.kind === 'ok' ? check.fingerprintChanged : null,
      scrape,
    });
  } catch (e) {
    if (signal.aborted) return;
    res.status(500).json({ error: e instanceof Error ? e.message : 'Refresh failed' });
  }
});

/** POST /api/registry/refresh — run the due set now (a manual scheduler
 *  tick, D10's body without the timer): verify each due record with ONE
 *  cheap fetch and feed the health state machine. No scraping — the
 *  response flags fingerprintChanged pages for the caller to scrape. */
registryRoutes.post('/refresh', async (req: Request, res: Response) => {
  const signal = disconnectSignal(res);
  const dueRecords = registry.due(Date.now(), config.discovery.refreshPerTick);
  const results: Array<{
    id: string;
    url: string;
    outcome: 'ok' | 'miss' | 'blocked' | 'skipped';
    reason?: string;
    fingerprintChanged?: boolean;
  }> = [];
  for (const rec of dueRecords) {
    if (signal.aborted) return;
    const guardErr = await guardFetch(rec.url);
    if (guardErr) {
      results.push({ id: rec.id, url: rec.url, outcome: 'skipped', reason: guardErr });
      continue;
    }
    try {
      const { outcome } = await verifyManual(rec.url, rec.label, signal);
      const check = toCheckOutcome(rec, outcome.verification);
      registry.recordCheck(rec.id, check);
      results.push({
        id: rec.id,
        url: rec.url,
        outcome: check.kind,
        ...(check.kind === 'ok' ? { fingerprintChanged: check.fingerprintChanged } : {}),
      });
    } catch (e) {
      results.push({
        id: rec.id,
        url: rec.url,
        outcome: 'skipped',
        reason: e instanceof Error ? e.message : 'verify failed',
      });
    }
  }
  res.json({ checked: results.length, results });
});

/* ── IMPORT ───────────────────────────────────────────────────────── */

/** Import merge accepts exported records; anything unverifiable is filled
 *  with conservative defaults and recomputed ids (url is the identity). */
function sanitizeImported(raw: unknown): DealPageRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<DealPageRecord>;
  if (typeof r.url !== 'string' || !r.url) return null;
  const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const numOrNull = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const status = ALL_STATUSES.has(r.status as RegistryStatus)
    ? (r.status as RegistryStatus)
    : 'candidate';
  const now = Date.now();
  return {
    id: registry.recordId(r.url),
    url: r.url,
    domain: typeof r.domain === 'string' && r.domain ? r.domain : new URL(r.url).hostname,
    site: typeof r.site === 'string' && r.site ? r.site : new URL(r.url).hostname,
    status,
    source: r.source ?? 'user',
    evidence: Array.isArray(r.evidence)
      ? r.evidence.filter((e): e is string => typeof e === 'string').slice(0, 20)
      : [],
    label: typeof r.label === 'string' ? r.label : null,
    firstSeenAt: num(r.firstSeenAt, now),
    lastSeenAt: num(r.lastSeenAt, now),
    lastVerifiedAt: numOrNull(r.lastVerifiedAt),
    lastScrapedAt: numOrNull(r.lastScrapedAt),
    lastChangedAt: numOrNull(r.lastChangedAt),
    nextCheckAt: num(r.nextCheckAt, now),
    revisitAfter: numOrNull(r.revisitAfter),
    finalScore: num(r.finalScore),
    dealDensity: num(r.dealDensity),
    avgProductCount: num(r.avgProductCount),
    medianDiscountPct: numOrNull(r.medianDiscountPct),
    productFingerprint: typeof r.productFingerprint === 'string' ? r.productFingerprint : null,
    checkCount: num(r.checkCount),
    successCount: num(r.successCount),
    consecutiveMisses: num(r.consecutiveMisses),
    changeRate: num(r.changeRate),
    seasonHint: Array.isArray(r.seasonHint)
      ? r.seasonHint.filter((m): m is number => Number.isInteger(m) && m >= 1 && m <= 12)
      : [],
    userPinned: status === 'pinned',
    notes: typeof r.notes === 'string' ? r.notes : null,
  };
}

/** POST /api/registry/import — merge; never clobbers pinned/excluded. */
registryRoutes.post('/import', (req: Request, res: Response) => {
  const raw = Array.isArray(req.body) ? req.body : req.body?.records;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10_000) {
    res.status(400).json({ error: 'Body must be { "records": DealPageRecord[] } (1..10000)' });
    return;
  }
  const records = raw.map(sanitizeImported).filter((r): r is DealPageRecord => r !== null);
  if (!records.length) {
    res.status(400).json({ error: 'No valid records — each needs at least a "url" string' });
    return;
  }
  res.json(registry.importRecords(records));
});
