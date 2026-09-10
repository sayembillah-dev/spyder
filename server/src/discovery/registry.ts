import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config';
import type { CandidateSource, VerificationResult } from '../types';
import { siteNameFromUrl } from '../utils/sites';
import { registrableDomain } from '../utils/sameSite';

/**
 * D6.1 — the deal-URL registry: the DURABLE saved list.
 *
 *   "Which pages sell discounted things?" — keyed by URL, kept forever.
 *
 * This is the artifact the rest of the system exists to serve: every URL
 * discovery has ever verified, with enough health data for the scheduler
 * (D10) to decide when to fetch it again. Losing it loses user work, so —
 * unlike the throwaway caches — writes are atomic (tmp + fsync + rename),
 * one .bak of the last good file is kept, and a corrupt primary LOUDLY
 * falls back to the backup instead of silently starting fresh.
 *
 * Invariants (mirroring strategyCache):
 *   1. status 'blocked' NEVER changes a record. A WAF says nothing about
 *      whether a page sells discounted goods.
 *   2. 'pinned' and 'excluded' are USER facts. No automatic rule ever
 *      overwrites them — not eviction, not TTL, not consecutiveMisses.
 *   3. Health stats are EWMA (α ≈ 0.3): one bad check moves the number,
 *      never decides the outcome.
 *   4. Re-discovery UPSERTS by id — refreshes lastSeenAt and evidence,
 *      never resets health, never resurrects an 'excluded' entry.
 */

export type RegistryStatus =
  | 'candidate' // found and scored, not yet verified
  | 'active' // verified, has deals — auto-fetch this
  | 'stale' // not verified within staleAfterHours — re-verify before use
  | 'parked' // verified empty/dead. NOT deleted — see the seasonal note
  | 'excluded' // user said no. never auto-fetch, never re-add
  | 'pinned'; // user said yes. never demoted, never evicted, never scored

export interface DealPageRecord {
  id: string; // sha1(canonical url) — stable primary key
  url: string; // canonical form (D1.2)
  domain: string; // registrable domain (D1.1)
  site: string; // display name
  status: RegistryStatus;
  source: CandidateSource;
  evidence: string[]; // why we ever believed in this URL
  /** The merchant's OWN label — "Eid Flash Sale", "Clearance". */
  label: string | null;

  firstSeenAt: number;
  lastSeenAt: number; // last time discovery re-found it
  lastVerifiedAt: number | null;
  lastScrapedAt: number | null;
  lastChangedAt: number | null; // last time the product set actually changed
  /** The scheduler's sort key. THE index this whole store exists for. */
  nextCheckAt: number;
  /** Parked seasonal pages wake up here (e.g. next November for Black Friday). */
  revisitAfter: number | null;

  // Rolling health — EWMA, never last-value.
  finalScore: number;
  dealDensity: number;
  avgProductCount: number;
  medianDiscountPct: number | null;
  productFingerprint: string | null;
  checkCount: number;
  successCount: number;
  consecutiveMisses: number;
  /** Fraction of checks where the fingerprint changed → drives cadence. */
  changeRate: number;
  /** Months (1-12) this page has ever been active — learned seasonality. */
  seasonHint: number[];

  userPinned: boolean;
  notes: string | null;
}

const REGISTRY_DIR = fileURLToPath(new URL('../../.cache', import.meta.url));
const REGISTRY_PATH = fileURLToPath(new URL('../../.cache/deal-registry.json', import.meta.url));
const REGISTRY_BAK = `${REGISTRY_PATH}.bak`;

const EWMA_ALPHA = 0.3;
const MAX_EVIDENCE = 20;
/** Parked pages past revisitAfter by more than this are evictable. */
const PARKED_EVICT_AFTER_MS = 365 * 24 * 3600_000;

export function recordId(canonicalUrl: string): string {
  return createHash('sha1').update(canonicalUrl).digest('hex').slice(0, 16);
}

const ewma = (prev: number, sample: number, alpha: number = EWMA_ALPHA): number =>
  alpha * sample + (1 - alpha) * prev;

/* ── persistence: atomic write + one backup + loud corrupt fallback ── */

let store: Map<string, DealPageRecord> | null = null;

function validate(raw: unknown): raw is Record<string, DealPageRecord> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw);
}

function load(): Map<string, DealPageRecord> {
  if (store) return store;
  store = new Map();
  if (!existsSync(REGISTRY_PATH)) return store;
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as unknown;
  try {
    const raw = read(REGISTRY_PATH);
    if (!validate(raw)) throw new Error('registry root is not an object');
    for (const [id, rec] of Object.entries(raw)) {
      if (rec && typeof rec === 'object' && typeof rec.url === 'string') store.set(id, rec);
    }
  } catch (primaryErr) {
    // Corrupt primary → LOUDLY fall back to the backup (durable data does
    // not get the caches' silent start-fresh treatment).
    console.error(`[registry] corrupt primary (${String(primaryErr)}) — trying .bak`);
    try {
      const raw = read(REGISTRY_BAK);
      if (!validate(raw)) throw new Error('backup root is not an object');
      for (const [id, rec] of Object.entries(raw)) {
        if (rec && typeof rec === 'object' && typeof rec.url === 'string') store.set(id, rec);
      }
      console.error(`[registry] recovered ${store.size} records from .bak`);
    } catch (bakErr) {
      console.error(`[registry] .bak also unreadable (${String(bakErr)}) — starting EMPTY`);
      store = new Map();
    }
  }
  return store;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 250);
}

/** Synchronous atomic write: tmp → fsync → rename, with one .bak kept.
 *  Exported so SIGTERM handling can force a final flush. */
export function flush(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!store) return;
  try {
    mkdirSync(REGISTRY_DIR, { recursive: true });
    const tmp = `${REGISTRY_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(store), null, 2));
    if (existsSync(REGISTRY_PATH)) copyFileSync(REGISTRY_PATH, REGISTRY_BAK);
    renameSync(tmp, REGISTRY_PATH); // atomic on POSIX — no torn writes
  } catch (err) {
    console.error('[registry] save failed:', err);
  }
}

/* ── queries ── */

export function get(id: string): DealPageRecord | undefined {
  return load().get(id);
}

export function findByUrl(canonicalUrl: string): DealPageRecord | undefined {
  return load().get(recordId(canonicalUrl));
}

export interface RegistryQuery {
  domain?: string;
  status?: RegistryStatus | RegistryStatus[];
  limit?: number;
  sort?: 'nextCheckAt' | 'lastVerifiedAt' | 'finalScore' | 'lastSeenAt';
}

export function list(q: RegistryQuery = {}): DealPageRecord[] {
  const statuses = q.status ? (Array.isArray(q.status) ? q.status : [q.status]) : null;
  let rows = [...load().values()];
  if (q.domain) rows = rows.filter((r) => r.domain === q.domain);
  if (statuses) rows = rows.filter((r) => statuses.includes(r.status));
  const key = q.sort ?? 'nextCheckAt';
  rows.sort((a, b) => {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
    return typeof av === 'number' && typeof bv === 'number' ? av - bv : 0;
  });
  return q.limit ? rows.slice(0, q.limit) : rows;
}

/* ── writes ── */

export interface UpsertInput {
  url: string; // canonical
  source: CandidateSource;
  evidence: string[];
  label?: string | null;
  finalScore: number;
  verified?: VerificationResult;
}

/**
 * Discovery re-found a URL → upsert. Refreshes lastSeenAt + evidence,
 * NEVER resets health, NEVER resurrects an excluded record. New URLs start
 * as 'candidate' (not yet verified) or 'active' (verification attached).
 */
export function upsert(input: UpsertInput, now: number = Date.now()): DealPageRecord {
  const id = recordId(input.url);
  const cache = load();
  const existing = cache.get(id);

  if (existing) {
    existing.lastSeenAt = now;
    existing.evidence = [...new Set([...existing.evidence, ...input.evidence])].slice(
      -MAX_EVIDENCE,
    );
    if (input.label && !existing.label) existing.label = input.label;
    // health, status, nextCheckAt: untouched — re-discovery is not a check.
    cache.set(id, existing);
    scheduleSave();
    return existing;
  }

  const url = new URL(input.url);
  const v = input.verified && !input.verified.rejectedReason ? input.verified : null;
  const rec: DealPageRecord = {
    id,
    url: input.url,
    domain: registrableDomain(url.hostname) ?? url.hostname,
    site: siteNameFromUrl(input.url),
    status: v ? 'active' : 'candidate',
    source: input.source,
    evidence: input.evidence.slice(-MAX_EVIDENCE),
    label: input.label ?? null,
    firstSeenAt: now,
    lastSeenAt: now,
    lastVerifiedAt: v ? now : null,
    lastScrapedAt: null,
    lastChangedAt: null,
    nextCheckAt: now, // new records are immediately due for a first check
    revisitAfter: null,
    finalScore: input.finalScore,
    // A verified-on-arrival record starts with its measured stats (first
    // EWMA sample), so the scheduler's fingerprint-change check (D10.3)
    // has a baseline from day one.
    dealDensity: v?.dealDensity ?? 0,
    avgProductCount: v?.productCount ?? 0,
    medianDiscountPct: v?.medianDiscountPct ?? null,
    productFingerprint: v?.productFingerprint ?? null,
    checkCount: v ? 1 : 0,
    successCount: v ? 1 : 0,
    consecutiveMisses: 0,
    changeRate: 0,
    seasonHint: v ? [new Date(now).getMonth() + 1] : [],
    userPinned: false,
    notes: null,
  };
  if (v) rec.nextCheckAt = computeNextCheck(rec, now);
  cache.set(id, rec);
  evictIfOverCap();
  scheduleSave();
  return rec;
}

export type CheckOutcome =
  | { kind: 'ok'; verification: VerificationResult; fingerprintChanged: boolean }
  | { kind: 'miss' } // dead / no products / no discounts
  | { kind: 'blocked' }; // invariant 1: changes NOTHING

const PARK_AFTER_MISSES = 2;

/**
 * Record a verification/scrape check against a record. This is the D6.2
 * state machine + EWMA health update + cadence recompute, in one place so
 * the request path and the scheduler share exactly one code path.
 */
export function recordCheck(
  id: string,
  outcome: CheckOutcome,
  now: number = Date.now(),
): DealPageRecord | undefined {
  const rec = load().get(id);
  if (!rec) return undefined;
  if (outcome.kind === 'blocked') return rec; // invariant 1 — nothing changes
  if (rec.status === 'pinned' || rec.status === 'excluded') {
    // invariant 2 — user facts are never overwritten by automatic rules.
    // A check still refreshes timestamps/stats (the data is real), but
    // status and cadence are the user's call.
    if (outcome.kind === 'ok') applySuccess(rec, outcome, now);
    scheduleSave();
    return rec;
  }

  if (outcome.kind === 'ok') {
    applySuccess(rec, outcome, now);
    rec.status = 'active';
    rec.consecutiveMisses = 0;
  } else {
    rec.consecutiveMisses += 1;
    rec.checkCount += 1;
    if (rec.consecutiveMisses >= PARK_AFTER_MISSES) {
      // Parked, NOT deleted: a Black Friday page 404s for eleven months.
      // revisitAfter = the next month this page was ever live (seasonHint),
      // else a conservative 30 days.
      rec.status = 'parked';
      rec.revisitAfter = nextSeasonalWake(rec, now);
    } else if (rec.status === 'active') {
      rec.status = 'stale'; // one miss: benefit of the doubt
    }
  }
  rec.nextCheckAt = computeNextCheck(rec, now);
  scheduleSave();
  return rec;
}

/** D10: a `blocked` check changes NOTHING about health (invariant 1) — but
 *  the scheduler must still back off, or the record is retried every tick.
 *  Moves nextCheckAt forward only; status and stats untouched. */
export function backoff(
  id: string,
  until: number,
): DealPageRecord | undefined {
  const rec = load().get(id);
  if (!rec) return undefined;
  if (until > rec.nextCheckAt) {
    rec.nextCheckAt = until;
    scheduleSave();
  }
  return rec;
}

function applySuccess(
  rec: DealPageRecord,
  outcome: { kind: 'ok'; verification: VerificationResult; fingerprintChanged: boolean },
  now: number,
): void {
  const v = outcome.verification;
  rec.lastVerifiedAt = now;
  rec.checkCount += 1;
  rec.successCount += 1;
  rec.dealDensity = rec.checkCount === 1 ? v.dealDensity : ewma(rec.dealDensity, v.dealDensity);
  rec.avgProductCount =
    rec.checkCount === 1 ? v.productCount : ewma(rec.avgProductCount, v.productCount);
  rec.medianDiscountPct = v.medianDiscountPct ?? rec.medianDiscountPct;
  rec.finalScore = Math.max(rec.finalScore, ewma(rec.finalScore, 1));
  rec.changeRate = ewma(rec.changeRate, outcome.fingerprintChanged ? 1 : 0);
  if (outcome.fingerprintChanged) {
    rec.lastChangedAt = now;
    rec.productFingerprint = v.productFingerprint;
  }
  const month = new Date(now).getMonth() + 1;
  if (!rec.seasonHint.includes(month)) rec.seasonHint.push(month);
}

/** D10.2 — adaptive cadence: the page's own measured behaviour decides. */

/**
 * Calibrated activity weights. The plan's literal linear form
 * (BASE/(0.5+changeRate+dealDensity)) cannot span 1h–7d over the 0..2
 * activity range with any single base, so the response is shaped instead:
 * changeRate dominates (churn is the real "check me again" signal) and
 * dealDensity is a mild nudge (a hot page deserves attention). 166 is
 * solved so a maximally-churning page (changeRate 1, density 1) lands on
 * the 1h floor: refreshMaxHours/(1+166+1) = 1h — while a never-changing
 * clearance page (density ~0.9, no churn) sits at ~88h, decaying toward
 * the 7d ceiling.
 */
const CHANGE_WEIGHT = 166;
const DENSITY_WEIGHT = 1;

export function computeNextCheck(rec: DealPageRecord, now: number = Date.now()): number {
  if (rec.status === 'parked') return rec.revisitAfter ?? now + 30 * 24 * 3600_000;
  const activity = CHANGE_WEIGHT * rec.changeRate + DENSITY_WEIGHT * rec.dealDensity;
  const intervalHours = config.discovery.refreshMaxHours / (1 + activity);
  const clamped = Math.min(
    Math.max(intervalHours, config.discovery.refreshMinHours),
    config.discovery.refreshMaxHours,
  );
  // ±15% jitter — without it, 200 records discovered in one session all
  // come due in the same tick forever.
  const jittered = clamped * (0.85 + Math.random() * 0.3);
  return now + Math.round(jittered * 3600_000);
}

/** Next month (1-12) this page was ever live; conservative 30 d fallback. */
function nextSeasonalWake(rec: DealPageRecord, now: number): number {
  if (rec.seasonHint.length === 0) return now + 30 * 24 * 3600_000;
  const month = new Date(now).getMonth() + 1;
  const future = [...rec.seasonHint].sort((a, b) => a - b).find((m) => m > month);
  const target = future ?? Math.min(...rec.seasonHint); // wrap to next year
  const wake = new Date(now);
  wake.setMonth(target - 1, 1);
  wake.setHours(0, 0, 0, 0);
  if (wake.getTime() <= now) wake.setFullYear(wake.getFullYear() + 1);
  return wake.getTime();
}

/* ── user actions (D7.3) ── */

/** Pin / exclude / re-activate / annotate. Returns null when absent. */
export function patch(
  id: string,
  updates: Partial<
    Pick<DealPageRecord, 'status' | 'label' | 'notes' | 'nextCheckAt'>
  > & { status?: 'pinned' | 'excluded' | 'active' },
): DealPageRecord | null {
  const rec = load().get(id);
  if (!rec) return null;
  if (updates.status) {
    rec.status = updates.status;
    rec.userPinned = updates.status === 'pinned';
    if (updates.status === 'excluded') rec.nextCheckAt = Number.MAX_SAFE_INTEGER;
    if (updates.status === 'active') rec.nextCheckAt = computeNextCheck(rec);
  }
  if (updates.label !== undefined) rec.label = updates.label;
  if (updates.notes !== undefined) rec.notes = updates.notes;
  if (updates.nextCheckAt !== undefined && updates.status !== 'excluded') {
    rec.nextCheckAt = updates.nextCheckAt;
  }
  scheduleSave();
  return rec;
}

/** Hard delete — distinct from 'excluded', which is a REMEMBERED "no". */
export function remove(id: string): boolean {
  const deleted = load().delete(id);
  if (deleted) scheduleSave();
  return deleted;
}

/* ── the scheduler's read (D10.1) ── */

/**
 * Entries due for a check: status active|stale|pinned, nextCheckAt <= now,
 * sorted by (priority, nextCheckAt), MAX 1 PER DOMAIN (perHostConcurrency
 * at the scheduler layer). Parked entries honour revisitAfter instead.
 */
export function due(now: number = Date.now(), cap: number = config.discovery.refreshPerTick): DealPageRecord[] {
  const rows = [...load().values()].filter((r) => {
    if (r.status === 'excluded' || r.status === 'candidate') return false;
    if (r.status === 'parked') return r.revisitAfter !== null && r.revisitAfter <= now;
    return r.nextCheckAt <= now;
  });
  rows.sort((a, b) => {
    // priority: pinned > active > stale > parked, then due time
    const prio = (r: DealPageRecord) =>
      r.status === 'pinned' ? 0 : r.status === 'active' ? 1 : r.status === 'stale' ? 2 : 3;
    return prio(a) - prio(b) || a.nextCheckAt - b.nextCheckAt;
  });
  const out: DealPageRecord[] = [];
  const seenDomains = new Set<string>();
  for (const r of rows) {
    if (out.length >= cap) break;
    if (seenDomains.has(r.domain)) continue; // one domain per tick
    seenDomains.add(r.domain);
    out.push(r);
  }
  return out;
}

/** Every active + pinned record — the "scrape my saved list" API case. */
export function scrapeable(): DealPageRecord[] {
  return [...load().values()].filter((r) => r.status === 'active' || r.status === 'pinned');
}

export function isExcluded(canonicalUrl: string): boolean {
  return load().get(recordId(canonicalUrl))?.status === 'excluded';
}

/* ── capacity + staleness ── */

function evictIfOverCap(): void {
  const cache = load();
  const max = config.discovery.registryMax;
  if (cache.size <= max) return;
  const now = Date.now();
  // Eviction order: parked past revisitAfter by > 1 year, then oldest
  // lastSeenAt among non-active. pinned and active are NEVER evicted —
  // hitting the cap with `max` active entries is a warning, not a deletion.
  const evictable = [...cache.values()]
    .filter((r) => r.status !== 'pinned' && r.status !== 'active')
    .sort((a, b) => {
      const aOverdue =
        a.status === 'parked' && a.revisitAfter !== null && now - a.revisitAfter > PARKED_EVICT_AFTER_MS;
      const bOverdue =
        b.status === 'parked' && b.revisitAfter !== null && now - b.revisitAfter > PARKED_EVICT_AFTER_MS;
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
      return a.lastSeenAt - b.lastSeenAt;
    });
  for (const r of evictable.slice(0, cache.size - max)) cache.delete(r.id);
  if (cache.size > max) {
    console.warn(`[registry] ${cache.size} records exceed cap ${max} with only active/pinned left`);
  }
}

/** Mark actives not verified within staleAfterHours as stale (lazy, on read). */
export function applyStaleness(now: number = Date.now()): number {
  const staleMs = config.discovery.staleAfterHours * 3600_000;
  let changed = 0;
  for (const rec of load().values()) {
    if (
      rec.status === 'active' &&
      rec.lastVerifiedAt !== null &&
      now - rec.lastVerifiedAt > staleMs
    ) {
      rec.status = 'stale';
      changed++;
    }
  }
  if (changed) scheduleSave();
  return changed;
}

/* ── export / import (D6.3: the list is the user's asset) ── */

export function exportJson(): DealPageRecord[] {
  return [...load().values()];
}

export function exportCsv(): string {
  const esc = (s: string | null) => (s === null ? '' : `"${s.replaceAll('"', '""')}"`);
  const rows = [...load().values()].map((r) =>
    [r.url, r.domain, esc(r.label), r.status, r.dealDensity.toFixed(3), String(r.lastVerifiedAt ?? '')].join(','),
  );
  return ['url,domain,label,status,dealDensity,lastVerifiedAt', ...rows].join('\n');
}

/** Merge imported records; NEVER clobbers pinned/excluded. */
export function importRecords(records: DealPageRecord[]): { added: number; skipped: number } {
  const cache = load();
  let added = 0;
  let skipped = 0;
  for (const rec of records) {
    const existing = cache.get(rec.id ?? recordId(rec.url));
    if (existing && (existing.status === 'pinned' || existing.status === 'excluded')) {
      skipped++;
      continue;
    }
    if (!existing) added++;
    cache.set(rec.id ?? recordId(rec.url), rec);
  }
  evictIfOverCap();
  scheduleSave();
  return { added, skipped };
}

/** Test-only: reset the in-memory store (does NOT touch the file). */
export function _resetForTests(): void {
  store = new Map();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}
