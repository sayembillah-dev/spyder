import { config } from '../config';
import { guardFetch, toCheckOutcome, verifyManual } from '../services/registryRefresh';
import { scrapeUrls } from '../services/scraperService';
import * as registry from './registry';

/**
 * D10 — the autonomous refresh loop. Deliberately dull: ONE timer, no
 * queue library, no cron parser. OFF by default (`AUTO_REFRESH=true` to
 * enable) — a background process that fetches other people's sites
 * unattended is opted into consciously, not inherited via `npm start`.
 *
 * What a refresh does (D10.3), per due record:
 *   1. guard chain (SSRF → robots → per-host delay) — no privileges a
 *      user request doesn't have;
 *   2. cheap verify — ONE fetch. Dead / no discounts → the registry's
 *      state machine handles it (miss → stale → parked). STOP.
 *   3. fingerprint unchanged → cadence updates, no scrape. STOP.
 *      (THE optimization: most refreshes end here, at one cheap GET.)
 *   4. changed → the full scrape ladder, browser rungs capped per hour.
 *
 * Non-negotiables (each is a way this goes wrong if skipped):
 *  - never overlap ticks (a slow site must not stack concurrent scrapes);
 *  - max 1 record per domain per tick (registry.due already guarantees);
 *  - blocked → back off, never demote (registry invariant #1);
 *  - N consecutive failures across DIFFERENT domains ⇒ the network is
 *    down, not the sites — pause instead of hammering;
 *  - never runs in the request path; full stop on SIGTERM, mid-tick.
 */

export interface SchedulerHooks {
  /** Test seams — production uses the real shared path. */
  guard?: typeof guardFetch;
  verify?: typeof verifyManual;
  scrape?: typeof scrapeUrls;
  now?: () => number;
  /** Override the browser-per-hour cap (tests). */
  browserPerHour?: number;
  /** Observability without a logging framework — one line per event. */
  onEvent?: (message: string) => void;
}

export interface SchedulerHandle {
  /** Stop the timer, abort the in-flight tick, wait for it to unwind.
   *  Idempotent. Called on SIGTERM before the registry flush. */
  stop(): Promise<void>;
  /** Run one tick immediately (tests; the timer calls this too). */
  tickNow(): Promise<void>;
  readonly running: boolean;
}

export function startScheduler(hooks: SchedulerHooks = {}): SchedulerHandle {
  const guard = hooks.guard ?? guardFetch;
  const verify = hooks.verify ?? verifyManual;
  const scrape = hooks.scrape ?? scrapeUrls;
  const now = hooks.now ?? (() => Date.now());
  const browserCap = hooks.browserPerHour ?? config.discovery.refreshBrowserPerHour;
  const say = hooks.onEvent ?? (() => {});

  let inFlight = false;
  let stopped = false;
  let pausedUntil = 0;
  let consecutiveFailures = 0; // across DIFFERENT domains (1/domain/tick)
  let browserRuns: number[] = []; // timestamps, last hour only
  let ac: AbortController | null = null;

  const browserRunsLastHour = () => {
    const cutoff = now() - 3_600_000;
    browserRuns = browserRuns.filter((t) => t > cutoff);
    return browserRuns.length;
  };

  async function tick(): Promise<void> {
    if (inFlight || stopped) return;
    inFlight = true;
    ac = new AbortController();
    const signal = ac.signal;
    try {
      const t0 = now();
      if (t0 < pausedUntil) {
        say(`⏸️ paused until ${new Date(pausedUntil).toISOString()} (failure burst)`);
        return;
      }
      const dueRecords = registry.due(t0, config.discovery.refreshPerTick);
      if (!dueRecords.length) return;

      for (const rec of dueRecords) {
        if (stopped || signal.aborted) break; // SIGTERM mid-tick
        if (now() < pausedUntil) break;

        const guardErr = await guard(rec.url);
        if (guardErr) {
          // A guard refusal is not a page failure — no health change.
          say(`⏭️ ${rec.url}: skipped (${guardErr})`);
          continue;
        }

        let verified: Awaited<ReturnType<typeof verify>>;
        try {
          verified = await verify(rec.url, rec.label, signal);
        } catch (e) {
          if (signal.aborted) break;
          say(`⚠️ ${rec.url}: verify threw (${e instanceof Error ? e.message : e}) — skipped`);
          continue;
        }

        const check = toCheckOutcome(rec, verified.outcome.verification);
        registry.recordCheck(rec.id, check, now());

        if (check.kind === 'blocked') {
          // Back off, never demote: health untouched (invariant #1), but
          // the record leaves the due set for at least the cadence floor.
          registry.backoff(rec.id, now() + config.discovery.refreshMinHours * 3_600_000);
          consecutiveFailures++;
          say(`🛡️ ${rec.url}: blocked — backed off ${config.discovery.refreshMinHours}h`);
        } else if (check.kind === 'miss') {
          consecutiveFailures++;
          say(`❌ ${rec.url}: ${verified.outcome.verification.rejectedReason}`);
        } else {
          consecutiveFailures = 0;
          if (!check.fingerprintChanged) {
            say(`✓ ${rec.url}: unchanged (1 fetch)`); // D10.3 step 2 — STOP
          } else if (browserRunsLastHour() >= browserCap) {
            // The change is recorded; the expensive re-scrape waits for a
            // user request or the cap window to slide.
            say(`⏳ ${rec.url}: changed, but the browser/hour cap is hit — scrape deferred`);
          } else {
            say(`♻️ ${rec.url}: products changed — full scrape`);
            try {
              const res = await scrape([rec.url], () => {}, signal, {
                discovery: { enabled: 'never' },
              });
              if (
                res.report.some((r) => r.method === 'browser' || r.method === 'browser-clean')
              ) {
                browserRuns.push(now());
              }
            } catch (e) {
              if (!signal.aborted) {
                say(`⚠️ ${rec.url}: scrape failed (${e instanceof Error ? e.message : e})`);
              }
            }
          }
        }

        // Failure-burst pause: N failures across different domains in a
        // row means OUR network is down — stop hammering everyone.
        if (consecutiveFailures >= config.discovery.refreshPauseAfterFailures) {
          pausedUntil = now() + config.discovery.refreshPauseMs;
          say(
            `⏸️ ${consecutiveFailures} consecutive failures across domains — ` +
              `pausing ${Math.round(config.discovery.refreshPauseMs / 60_000)}min`,
          );
          break;
        }
      }
    } finally {
      inFlight = false;
      ac = null;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, config.discovery.refreshTickMs);
  timer.unref(); // the scheduler never keeps the process alive on its own

  return {
    get running() {
      return !stopped;
    },
    tickNow: tick,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      ac?.abort(); // unwind the in-flight tick…
      while (inFlight) {
        await new Promise((r) => setTimeout(r, 25)); // …and wait for it
      }
    },
  };
}
