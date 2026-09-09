import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config';

/**
 * Per-host rate limiting — bans are the #1 cause of a scraper "randomly
 * breaking". Global concurrency limits don't help when two URLs point at
 * the SAME host: they hammer it simultaneously. This serializes requests
 * per hostname with a jittered gap, so one host never sees parallel load
 * or a metronomic rhythm.
 *
 * REENTRANCY: `runExclusive` holds a host's slot for an entire scrape job
 * (perHostConcurrency: 1), and code running INSIDE that job legitimately
 * needs to make further requests to the same host — SSR pagination fetches
 * page 2+ via `fetchHtml`, which itself calls `waitTurn`. Without tracking
 * "this async chain already holds host X", that nested call would await
 * the outer hold releasing, which never happens because the outer call is
 * itself blocked awaiting the nested one — a self-deadlock that hangs the
 * entire request (mapWithConcurrency's Promise.all never resolves, so even
 * unrelated URLs in the same batch never get a response). AsyncLocalStorage
 * threads the "currently held" set through the await chain so a nested
 * call for an already-held host proceeds immediately instead of queueing
 * behind itself.
 */
export class HostRateLimiter {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly lastStart = new Map<string, number>();
  private readonly held = new AsyncLocalStorage<ReadonlySet<string>>();

  private holdsHost(host: string): boolean {
    return this.held.getStore()?.has(host) ?? false;
  }

  private withHeld<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const current = this.held.getStore() ?? new Set<string>();
    return this.held.run(new Set(current).add(host), fn);
  }

  /** Wait for this host's turn, then a jittered quiet period. */
  async waitTurn(host: string): Promise<void> {
    if (this.holdsHost(host)) return; // already serialized by an ancestor call
    const prev = this.tails.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    this.tails.set(host, prev.then(() => mine));

    await prev; // serialize: one in flight per host
    await this.gap(host);
    release();
  }

  /**
   * Hold this host's slot for the WHOLE job (perHostConcurrency: 1) —
   * two URLs on one host must not run two browsers over it simultaneously.
   */
  async runExclusive<T>(host: string, fn: () => Promise<T>): Promise<T> {
    if (this.holdsHost(host)) return this.withHeld(host, fn); // reentrant: already held
    const prev = this.tails.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    this.tails.set(host, prev.then(() => mine));

    await prev;
    await this.gap(host);
    try {
      return await this.withHeld(host, fn);
    } finally {
      release();
    }
  }

  /** Jittered inter-request spacing since this host's last job start. */
  private async gap(host: string): Promise<void> {
    const since = Date.now() - (this.lastStart.get(host) ?? 0);
    const { minDelayMs, maxDelayMs } = config.net;
    const want = minDelayMs + Math.floor(Math.random() * Math.max(0, maxDelayMs - minDelayMs));
    const wait = want - since;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastStart.set(host, Date.now());
  }
}

/** Shared limiter for every HTTP/browser request path. */
export const hostRateLimiter = new HostRateLimiter();
