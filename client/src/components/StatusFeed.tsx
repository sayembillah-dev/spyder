import { AlertTriangle, CheckCircle2, Loader2, Search, Zap } from 'lucide-react';
import type { SiteStatusEvent } from '../types';

interface Props {
  statuses: SiteStatusEvent[];
}

/** Live per-site pipeline status: detecting → scraping → done/error. */
export function StatusFeed({ statuses }: Props) {
  if (!statuses.length) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {statuses.map((s) => (
        <div
          key={s.url}
          className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3"
        >
          <PhaseIcon phase={s.phase} method={s.method} />
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
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs text-zinc-400">{s.message}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function PhaseIcon({ phase, method }: { phase: string; method?: string }) {
  const cls = 'mt-0.5 h-4 w-4 shrink-0';
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
    default:
      return <Search className={`${cls} animate-pulse text-sky-400`} />;
  }
}
