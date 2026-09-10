import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config';

/**
 * D6.4 — the discovery memo: facts about SEARCHING a site, not about a page.
 * Keyed by registrable domain, TTL hours — a disposable cache. Losing it
 * costs exactly one slow run, so it gets the throwaway treatment (debounced
 * write, corrupt-file-starts-fresh) that the registry deliberately does not.
 */
export interface DiscoveryMemo {
  domain: string;
  platform: string | null;
  /** Sitemap URLs that worked — skip robots+sitemap discovery next time. */
  sitemapUrls: string[];
  /** Probed and 404'd — never probe again. */
  negativePaths: string[];
  /** Campaign API endpoint seen on the wire (Tier 4). */
  campaignApiEndpoint: string | null;
  lastDiscoveryAt: number;
}

const MEMO_DIR = fileURLToPath(new URL('../../.cache', import.meta.url));
const MEMO_PATH = fileURLToPath(new URL('../../.cache/discovery-memo.json', import.meta.url));

let store: Map<string, DiscoveryMemo> | null = null;

function load(): Map<string, DiscoveryMemo> {
  if (store) return store;
  store = new Map();
  try {
    if (existsSync(MEMO_PATH)) {
      const raw = JSON.parse(readFileSync(MEMO_PATH, 'utf8')) as Record<string, DiscoveryMemo>;
      for (const [domain, m] of Object.entries(raw)) {
        if (m && typeof m.domain === 'string') store.set(domain, m);
      }
    }
  } catch {
    store = new Map(); // corrupt memo → start fresh (it is all re-derivable)
  }
  return store;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(MEMO_DIR, { recursive: true });
      writeFileSync(MEMO_PATH, JSON.stringify(Object.fromEntries(load()), null, 2));
    } catch {
      /* best-effort — a memo is a hint, never worth failing over */
    }
  }, 250);
}

/** Fresh memos skip Tiers 0–2 work already done; stale ones are ignored. */
export function lookupMemo(domain: string, now: number = Date.now()): DiscoveryMemo | null {
  const m = load().get(domain);
  if (!m) return null;
  const ttlMs = config.discovery.memoTtlHours * 3600_000;
  return now - m.lastDiscoveryAt <= ttlMs ? m : null;
}

export function writeMemo(
  domain: string,
  update: Partial<Omit<DiscoveryMemo, 'domain' | 'lastDiscoveryAt'>>,
  now: number = Date.now(),
): void {
  const prev = load().get(domain);
  load().set(domain, {
    domain,
    platform: update.platform ?? prev?.platform ?? null,
    sitemapUrls: update.sitemapUrls ?? prev?.sitemapUrls ?? [],
    negativePaths: [...new Set([...(prev?.negativePaths ?? []), ...(update.negativePaths ?? [])])],
    campaignApiEndpoint: update.campaignApiEndpoint ?? prev?.campaignApiEndpoint ?? null,
    lastDiscoveryAt: now,
  });
  scheduleSave();
}

/** Test-only: reset the in-memory store. */
export function _resetMemoForTests(): void {
  store = new Map();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}
