import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  Loader2,
  Radar,
  Search,
  ShieldAlert,
  Zap,
} from 'lucide-react';
import type { SiteStatusEvent } from '../types';

interface Props {
  statuses: SiteStatusEvent[];
}

/**
 * Confidence thresholds mirror the server's escalation bar
 * (config.quality.escalateBelow = 0.35): below it the server itself
 * distrusted the result enough to walk further up the ladder.
 */
const CONFIDENCE_LOW = 0.35;
const CONFIDENCE_HIGH = 0.7;

/** Human-readable explanations for the server's quality flags. */
const FLAG_LABELS: Record<string, string> = {
  'mostly-fallback-links': 'many missing product links',
  'all-prices-identical': 'prices look templated',
  'extreme-variance': 'suspicious price spread',
  'low-coverage': 'page claims more products than captured',
  empty: 'nothing extracted',
};

/** Live per-site pipeline status: detecting → scraping → done/error/blocked. */
export function StatusFeed({ statuses }: Props) {
  if (!statuses.length) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {statuses.map((s) => {
        const blocked = Boolean(s.blockReason);
        return (
          <div
            key={s.url}
            className={`flex items-start gap-3 rounded-xl border p-3 ${
              blocked ? 'border-rose-500/40 bg-rose-500/5' : 'border-zinc-800 bg-zinc-900/60'
            }`}
          >
            <PhaseIcon phase={s.phase} method={s.method} blocked={blocked} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold">{s.site}</span>
                {s.renderType && (
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                      s.renderType === 'SSR'
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                        : 'border-violet-500/30 bg-violet-500/10 text-violet-300'
                    }`}
                  >
                    {s.renderType}
                  </span>
                )}
                {blocked && (
                  <span className="rounded border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-300">
                    Blocked
                  </span>
                )}
                {!blocked && s.phase === 'done' && typeof s.qualityScore === 'number' && (
                  <ConfidenceDot score={s.qualityScore} flags={s.qualityFlags} count={s.count} />
                )}
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-zinc-400">{s.message}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Green/amber/red extraction-confidence dot; the tooltip carries the "why":
 * e.g. "42 products, many missing product links — low confidence (31%)".
 * Exported: the Discovery panel and Saved Pages view reuse it for dealDensity.
 */
export function ConfidenceDot({
  score,
  flags,
  count,
}: {
  score: number;
  flags?: string[];
  count?: number;
}) {
  const level = score >= CONFIDENCE_HIGH ? 'high' : score >= CONFIDENCE_LOW ? 'medium' : 'low';
  const color =
    level === 'high' ? 'bg-emerald-400' : level === 'medium' ? 'bg-amber-400' : 'bg-rose-400';
  const why = [
    typeof count === 'number' ? `${count} products` : null,
    ...(flags ?? []).map((f) => FLAG_LABELS[f] ?? f),
  ]
    .filter(Boolean)
    .join(', ');
  const tip = `${why ? `${why} — ` : ''}${level} confidence (${Math.round(score * 100)}%)`;
  return (
    <span
      title={tip}
      aria-label={tip}
      className={`inline-block h-2 w-2 shrink-0 cursor-help rounded-full ${color}`}
    />
  );
}

function PhaseIcon({
  phase,
  method,
  blocked,
}: {
  phase: string;
  method?: string;
  blocked?: boolean;
}) {
  const cls = 'mt-0.5 h-4 w-4 shrink-0';
  if (blocked) return <ShieldAlert className={`${cls} text-rose-400`} />;
  switch (phase) {
    case 'done':
      return <CheckCircle2 className={`${cls} text-emerald-400`} />;
    case 'error':
      return <AlertTriangle className={`${cls} text-rose-400`} />;
    case 'scraping':
      return method === 'browser' ? (
        <Loader2 className={`${cls} animate-spin text-violet-400`} />
      ) : (
        <Zap className={`${cls} animate-pulse text-amber-400`} />
      );
    case 'discovering':
      return <Radar className={`${cls} animate-pulse text-sky-400`} />;
    case 'verifying':
      return <FlaskConical className={`${cls} animate-pulse text-amber-400`} />;
    default:
      return <Search className={`${cls} animate-pulse text-sky-400`} />;
  }
}
