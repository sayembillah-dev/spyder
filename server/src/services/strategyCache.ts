import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RenderType, ScrapeMethod } from '../types';
import type { BrowserProfileName } from './csrScraper';
import type { ExtractionStrategyName } from './extractor';
import { config } from '../config';

/**
 * Per-host strategy cache — what makes the engine *dynamic*: it gets faster
 * and more accurate the more you use it, with ZERO per-site code.
 *
 * THE CRITICAL DESIGN RULE: a cache entry is a HINT, never a rule.
 *   1. Hit  → start at the remembered rung (skip detection).
 *   2. Result scores ≥ threshold → refresh the entry, done.
 *   3. Result scores below       → discard the shortcut, walk the FULL
 *                                   ladder from rung 0, overwrite with the winner.
 *   4. consecutiveFailures ≥ 3   → evict the entry entirely.
 *   5. Entry older than TTL      → weak hint: used, but failure evicts fast.
 *   6. status: 'blocked'         → do NOT touch the cache. A block says
 *                                   nothing about which strategy is correct.
 * Nothing here is hardcoded; everything is learned and independently
 * re-derivable. A site redesign costs one slow run, then the cache
 * re-converges.
 */
export interface HostStrategy {
  host: string;
  renderType: RenderType;
  method: ScrapeMethod;
  profile: BrowserProfileName | null;
  /** Rung of the extraction ladder that produced the winning result. */
  extractionStrategy: ExtractionStrategyName | 'network' | null;
  /** DOM-rung selector that matched the most cards (learned, §4.2). */
  cardSelector: string | null;
  /** Product JSON API captured from network interception (learned, §4.2). */
  apiEndpoint: string | null;
  bestQuality: number;
  lastSuccessAt: number;
  successCount: number;
  consecutiveFailures: number;
}

const CACHE_DIR = fileURLToPath(new URL('../../.cache', import.meta.url));
const CACHE_PATH = fileURLToPath(new URL('../../.cache/strategies.json', import.meta.url));
const MAX_ENTRIES = 500;

let store: Map<string, HostStrategy> | null = null;

function load(): Map<string, HostStrategy> {
  if (store) return store;
  store = new Map();
  try {
    if (existsSync(CACHE_PATH)) {
      const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Record<string, HostStrategy>;
      for (const [host, s] of Object.entries(raw)) {
        if (s && typeof s === 'object' && typeof s.method === 'string') store.set(host, s);
      }
    }
  } catch {
    // a corrupt cache must never break scraping — start fresh
    store = new Map();
  }
  return store;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(CACHE_PATH, JSON.stringify(Object.fromEntries(load()), null, 2));
    } catch {
      /* cache writes are best-effort — never fail a scrape over them */
    }
  }, 250);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Look up the remembered strategy for a host. Stale entries (older than the
 * TTL) are still returned — the caller treats them as weak hints and
 * re-validates; they just don't survive a failure.
 */
export function lookupStrategy(url: string): HostStrategy | null {
  const s = load().get(hostOf(url));
  return s ?? null;
}

export function isStale(s: HostStrategy): boolean {
  const ttlMs = config.cache.ttlDays * 24 * 60 * 60 * 1000;
  return Date.now() - s.lastSuccessAt > ttlMs;
}

export interface StrategyWin {
  renderType: RenderType;
  method: ScrapeMethod;
  profile: BrowserProfileName | null;
  extractionStrategy: ExtractionStrategyName | 'network' | null;
  cardSelector: string | null;
  apiEndpoint: string | null;
  quality: number;
}

/** A run that beat the quality bar: refresh (or create) the entry. */
export function recordSuccess(url: string, win: StrategyWin): void {
  const cache = load();
  const host = hostOf(url);
  const prev = cache.get(host);
  cache.set(host, {
    host,
    renderType: win.renderType,
    method: win.method,
    profile: win.profile,
    extractionStrategy: win.extractionStrategy,
    cardSelector: win.cardSelector ?? prev?.cardSelector ?? null,
    apiEndpoint: win.apiEndpoint ?? prev?.apiEndpoint ?? null,
    bestQuality: Math.max(win.quality, prev?.bestQuality ?? 0),
    lastSuccessAt: Date.now(),
    successCount: (prev?.successCount ?? 0) + 1,
    consecutiveFailures: 0,
  });
  if (cache.size > MAX_ENTRIES) {
    // evict least-recently-successful first
    const byAge = [...cache.values()].sort((a, b) => a.lastSuccessAt - b.lastSuccessAt);
    for (const s of byAge.slice(0, cache.size - MAX_ENTRIES)) cache.delete(s.host);
  }
  scheduleSave();
}

/**
 * A run that found nothing (or errored). NOT called on blocks — a block
 * says nothing about strategy correctness and must not poison the cache.
 */
export function recordFailure(url: string): void {
  const cache = load();
  const host = hostOf(url);
  const prev = cache.get(host);
  if (!prev) return;
  prev.consecutiveFailures += 1;
  // stale entries don't get the benefit of the doubt
  const limit = isStale(prev) ? 1 : 3;
  if (prev.consecutiveFailures >= limit) cache.delete(host);
  else cache.set(host, prev);
  scheduleSave();
}
