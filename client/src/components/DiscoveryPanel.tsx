import {
  Ban,
  ChevronDown,
  ChevronRight,
  Gauge,
  MemoryStick,
  Pin,
  PinOff,
  Timer,
  Undo2,
} from 'lucide-react';
import { useState } from 'react';
import type { CandidateSource, DealCandidate, DiscoveryReport } from '../types';
import { ConfidenceDot } from './StatusFeed';

interface Props {
  report: DiscoveryReport;
  /** Patterns already queued for the NEXT run. */
  include: string[];
  exclude: string[];
  /** Pin/exclude a URL — writes into discovery.include/.exclude (D8.1). */
  onPin: (url: string) => void;
  onExclude: (url: string) => void;
}

const SOURCE_CHIP: Record<CandidateSource, string> = {
  root: 'border-zinc-600 bg-zinc-800 text-zinc-300',
  nav: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  hero: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
  body: 'border-zinc-600 bg-zinc-800 text-zinc-300',
  footer: 'border-zinc-600 bg-zinc-800 text-zinc-400',
  sitemap: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  probe: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  platform: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  network: 'border-pink-500/30 bg-pink-500/10 text-pink-300',
  expanded: 'border-lime-500/30 bg-lime-500/10 text-lime-300',
  memo: 'border-zinc-600 bg-zinc-800 text-zinc-300',
  user: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
};

/** "https://shop.com/campaign/eid-sale?x=1" → "/campaign/eid-sale". */
function shortPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? '(homepage)' : u.pathname + u.search;
  } catch {
    return url;
  }
}

function scoreOf(c: DealCandidate): number {
  return c.finalScore ?? c.priorScore;
}

/**
 * One domain's discovery story: what was found, what verified, what was
 * rejected and WHY. The rejects being visible is the point — silent
 * selection is unauditable (D7.2).
 */
export function DiscoveryPanel({ report, include, exclude, onPin, onExclude }: Props) {
  const [showRejected, setShowRejected] = useState(false);
  const selected = [...report.selected].sort((a, b) => scoreOf(b) - scoreOf(a));

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-bold tracking-tight">
          <span className="text-zinc-500">Discovery:</span> {report.domain}
        </h3>
        {report.platform && (
          <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-300">
            {report.platform}
          </span>
        )}
        {report.fromMemo && (
          <span
            className="flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-zinc-400"
            title="Answered from the saved list — pages re-verified cheaply, full scan skipped"
          >
            <MemoryStick className="h-3 w-3" /> warm start
          </span>
        )}
        {report.budgetExhausted && (
          <span
            className="flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-300"
            title="Hit the per-run fetch/time budget — results may be partial"
          >
            <Gauge className="h-3 w-3" /> budget exhausted
          </span>
        )}
        <span className="ml-auto flex items-center gap-1 text-xs text-zinc-500">
          <Timer className="h-3 w-3" />
          {report.candidatesFound} found · {report.candidatesVerified} verified ·{' '}
          {report.fetchCount} fetches · {(report.durationMs / 1000).toFixed(1)}s
        </span>
      </div>

      {/* Selected candidates */}
      {selected.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {selected.map((c) => (
            <CandidateRow
              key={c.url}
              c={c}
              pinned={include.includes(c.url)}
              excluded={exclude.includes(c.url)}
              onPin={onPin}
              onExclude={onExclude}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-zinc-500">
          No deal pages cleared the bar on this domain.
        </p>
      )}

      {/* Rejected — collapsed behind "N rejected — why?" */}
      {report.rejected.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setShowRejected((v) => !v)}
            className="flex items-center gap-1 text-xs font-semibold text-zinc-500 transition hover:text-zinc-300"
          >
            {showRejected ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            {report.rejected.length} rejected — why?
          </button>
          {showRejected && (
            <ul className="mt-2 space-y-1.5 border-l-2 border-zinc-800 pl-3">
              {report.rejected.map((c) => (
                <CandidateRow
                  key={c.url}
                  c={c}
                  compact
                  pinned={include.includes(c.url)}
                  excluded={exclude.includes(c.url)}
                  onPin={onPin}
                  onExclude={onExclude}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function CandidateRow({
  c,
  compact = false,
  pinned,
  excluded,
  onPin,
  onExclude,
}: {
  c: DealCandidate;
  compact?: boolean;
  pinned: boolean;
  excluded: boolean;
  onPin: (url: string) => void;
  onExclude: (url: string) => void;
}) {
  const v = c.verified;
  const score = scoreOf(c);
  const evidenceTip = c.evidence.join('\n');
  return (
    <li
      className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${
        compact
          ? 'border-zinc-800/60 bg-zinc-950/40 text-zinc-500'
          : 'border-zinc-800 bg-zinc-950/60'
      }`}
      title={evidenceTip ? `Evidence:\n${evidenceTip}` : undefined}
    >
      {/* Score */}
      <span
        className={`w-11 shrink-0 text-right font-mono text-xs font-bold ${
          compact ? 'text-zinc-600' : score >= 0.55 ? 'text-emerald-400' : 'text-amber-400'
        }`}
        title={c.finalScore != null ? 'final score (post-verification)' : 'prior score (pre-fetch)'}
      >
        {score.toFixed(2)}
      </span>

      {/* Source chip */}
      <span
        className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${SOURCE_CHIP[c.source]}`}
      >
        {c.source}
      </span>

      {/* D9: this page is standing in for a deal page the site doesn't have */}
      {c.evidence.includes('fallback:category-listing') && (
        <span
          className="shrink-0 rounded border border-teal-500/30 bg-teal-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-teal-300"
          title="No dedicated sale page found — discounted items were filtered out of this category listing"
        >
          fallback
        </span>
      )}

      {/* Label / path */}
      <span className="min-w-0 flex-1 truncate text-sm">
        {c.label ? (
          <>
            <span className={compact ? 'text-zinc-400' : 'font-semibold text-zinc-200'}>
              {c.label}
            </span>{' '}
            <span className="font-mono text-xs text-zinc-500">{shortPath(c.url)}</span>
          </>
        ) : (
          <span className="font-mono text-xs">{shortPath(c.url)}</span>
        )}
      </span>

      {/* Verdict */}
      {v && (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-400">
          {!compact && <ConfidenceDot score={v.dealDensity} />}
          {v.productCount} products · {Math.round(v.dealDensity * 100)}% deals
          {v.hasCountdown && ' · ⏳'}
          {v.rejectedReason && (
            <span className="rounded border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-bold text-rose-300">
              {v.rejectedReason}
            </span>
          )}
        </span>
      )}
      {!v && c.evidence.length > 0 && compact && (
        <span className="shrink-0 text-xs text-zinc-600">{c.evidence[c.evidence.length - 1]}</span>
      )}

      {/* Pin / exclude — writes into the next run's discovery options */}
      <button
        onClick={() => onPin(c.url)}
        className={`shrink-0 rounded-lg border p-1.5 transition ${
          pinned
            ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
            : 'border-zinc-800 text-zinc-500 hover:border-amber-500/40 hover:text-amber-300'
        }`}
        title={
          pinned
            ? 'Pinned — remove from next run’s include list'
            : 'Pin — always include this page in the next run'
        }
      >
        {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
      </button>
      <button
        onClick={() => onExclude(c.url)}
        className={`shrink-0 rounded-lg border p-1.5 transition ${
          excluded
            ? 'border-rose-500/50 bg-rose-500/15 text-rose-300'
            : 'border-zinc-800 text-zinc-500 hover:border-rose-500/40 hover:text-rose-300'
        }`}
        title={
          excluded
            ? 'Excluded — remove from next run’s exclude list'
            : 'Exclude — never surface this page again'
        }
      >
        {excluded ? <Undo2 className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
      </button>
    </li>
  );
}
