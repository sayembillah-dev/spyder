import type { CheckOutcome, DealPageRecord } from '../discovery/registry';
import { finalScore, verifyCandidate } from '../discovery/verify';
import { config } from '../config';
import type { DealCandidate, VerificationResult } from '../types';
import { hostRateLimiter } from '../utils/rateLimit';
import { allowedByRobots } from '../utils/robots';
import { assertPublicUrl, BlockedTargetError } from '../utils/ssrf';

/**
 * The single verify-a-saved-page path, shared by the registry API routes
 * (user-requested adds/refreshes) and the D10 scheduler. One code path,
 * always: the scheduler gets NO privileges a request doesn't have —
 * same SSRF guard, same robots, same per-host politeness delay.
 */

/** The guard chain applied before ANY fetch of a registry URL:
 *  SSRF → robots → per-host delay. Returns an error message or null. */
export async function guardFetch(url: string): Promise<string | null> {
  try {
    await assertPublicUrl(url);
  } catch (e) {
    return e instanceof BlockedTargetError ? e.message : 'URL is not fetchable';
  }
  if (config.net.respectRobots && !config.net.robotsOverride && !(await allowedByRobots(url))) {
    return 'Disallowed by robots.txt (set ROBOTS_OVERRIDE=true to bypass)';
  }
  await hostRateLimiter.waitTurn(new URL(url).hostname, {
    min: config.discovery.hostDelayMs,
    max: config.discovery.hostDelayMs,
  });
  return null;
}

/** Cheap-verify one saved page: ONE fetch, measured by the same D4.2 gate
 *  discovery uses. Source 'user' + top prior — a human (or the registry's
 *  own memory) vouched for this URL; the gate still decides what it is
 *  TODAY. */
export async function verifyManual(url: string, label: string | null, signal?: AbortSignal) {
  const candidate: DealCandidate = {
    url,
    source: 'user',
    evidence: ['manual-add'],
    priorScore: 1,
    label,
  };
  const outcome = await verifyCandidate(candidate, signal);
  candidate.finalScore = finalScore(candidate, outcome.verification);
  return { candidate, outcome };
}

/** Map a verification onto the registry health state machine (the same
 *  mapping the orchestrator's warm start uses). */
export function toCheckOutcome(rec: DealPageRecord, v: VerificationResult): CheckOutcome {
  if (v.rejectedReason?.startsWith('blocked')) return { kind: 'blocked' };
  if (v.rejectedReason) return { kind: 'miss' };
  return {
    kind: 'ok',
    verification: v,
    fingerprintChanged: v.productFingerprint !== rec.productFingerprint,
  };
}
