import { Crown, ExternalLink, TrendingDown } from 'lucide-react';
import type { ComparisonGroup } from '../types';
import { fmtPrice, siteBadgeClass } from '../utils';

export function ComparisonView({ groups }: { groups: ComparisonGroup[] }) {
  if (!groups.length) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-800 p-10 text-center text-sm text-zinc-500">
        No cross-site matches yet — add URLs from multiple stores that sell the same items.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <div
          key={g.key}
          className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
            <h3 className="text-sm font-semibold text-zinc-100">{g.representativeTitle}</h3>
            <span className="flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-bold text-emerald-300">
              <TrendingDown className="h-3.5 w-3.5" />
              Save up to {fmtPrice(g.savings)} ({g.savingsPercent}%)
            </span>
          </div>

          <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3">
            {g.items.map((p, i) => (
              <a
                key={p.id}
                href={p.productUrl}
                target="_blank"
                rel="noreferrer"
                className={`flex items-center gap-3 rounded-xl border p-2.5 transition hover:bg-zinc-800/80 ${
                  i === 0
                    ? 'border-emerald-500/40 bg-emerald-500/5'
                    : 'border-zinc-800 bg-zinc-900'
                }`}
              >
                {p.imageUrl ? (
                  <img
                    src={p.imageUrl}
                    alt=""
                    loading="lazy"
                    className="h-12 w-12 shrink-0 rounded-lg bg-zinc-800 object-cover"
                  />
                ) : (
                  <div className="h-12 w-12 shrink-0 rounded-lg bg-zinc-800" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-1 text-xs text-zinc-400">{p.title}</div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-sm font-bold ${i === 0 ? 'text-emerald-400' : 'text-zinc-200'}`}
                    >
                      {fmtPrice(p.dealPrice, p.currency)}
                    </span>
                    {p.originalPrice !== null && p.originalPrice > p.dealPrice && (
                      <span className="text-[11px] text-zinc-500 line-through">
                        {fmtPrice(p.originalPrice, p.currency)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  {i === 0 && (
                    <span className="flex items-center gap-0.5 text-[10px] font-bold uppercase text-emerald-400">
                      <Crown className="h-3 w-3" />
                      Best
                    </span>
                  )}
                  <span
                    className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${siteBadgeClass(p.sourceSite)}`}
                  >
                    {p.sourceSite}
                    <ExternalLink className="h-2.5 w-2.5" />
                  </span>
                </div>
              </a>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
