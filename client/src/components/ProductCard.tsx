import { ExternalLink, ImageOff, Percent } from 'lucide-react';
import { useState } from 'react';
import type { ScrapedProduct } from '../types';
import { fmtPrice, siteBadgeClass } from '../utils';

export function ProductCard({ p }: { p: ScrapedProduct }) {
  const [imgBroken, setImgBroken] = useState(false);

  return (
    <a
      href={p.productUrl}
      target="_blank"
      rel="noreferrer"
      className="group flex flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60 transition hover:border-zinc-600 hover:bg-zinc-900"
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-zinc-800">
        {p.imageUrl && !imgBroken ? (
          <img
            src={p.imageUrl}
            alt={p.title}
            loading="lazy"
            onError={() => setImgBroken(true)}
            className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-zinc-600">
            <ImageOff className="h-8 w-8" />
          </div>
        )}
        {p.discountPercentage !== null && p.discountPercentage > 0 && (
          <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-rose-500 px-2 py-0.5 text-xs font-bold text-white shadow-lg">
            <Percent className="h-3 w-3" />
            {p.discountPercentage}% OFF
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <h3 className="line-clamp-2 min-h-[2.5rem] text-sm font-medium leading-snug text-zinc-100">
          {p.title}
        </h3>
        <div className="mt-auto flex items-end justify-between gap-2">
          <div>
            <div className="text-lg font-bold text-emerald-400">
              {fmtPrice(p.dealPrice, p.currency)}
            </div>
            {p.originalPrice !== null && p.originalPrice > p.dealPrice && (
              <div className="text-xs text-zinc-500 line-through">
                {fmtPrice(p.originalPrice, p.currency)}
              </div>
            )}
          </div>
          <span
            className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold ${siteBadgeClass(p.sourceSite)}`}
          >
            {p.sourceSite}
            <ExternalLink className="h-3 w-3" />
          </span>
        </div>
      </div>
    </a>
  );
}
