import {
  AlertTriangle,
  Filter,
  Flame,
  GitCompareArrows,
  LayoutGrid,
  Loader2,
  Percent,
  Rocket,
  Sparkles,
  Store,
  Timer,
  Zap,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { streamScrape } from './api';
import { ComparisonView } from './components/ComparisonView';
import { ProductCard } from './components/ProductCard';
import { StatusFeed } from './components/StatusFeed';
import type { ScrapeResult, SiteStatusEvent } from './types';

const SAMPLE_URLS = [
  'https://chaldal.com/popular',
  'https://www.pickaboo.com/product/walton-ac',
];

type View = 'grid' | 'compare';

export default function App() {
  const [urlText, setUrlText] = useState('');
  const [loading, setLoading] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, SiteStatusEvent>>({});
  const [result, setResult] = useState<ScrapeResult | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<View>('grid');
  const closeRef = useRef<(() => void) | null>(null);

  const start = (urls: string[]) => {
    closeRef.current?.();
    setLoading(true);
    setStatuses({});
    setResult(null);
    setFatalError(null);
    closeRef.current = streamScrape(urls, {
      onStatus: (e) => setStatuses((prev) => ({ ...prev, [e.url]: e })),
      onDone: (r) => {
        setResult(r);
        setLoading(false);
      },
      onError: (msg) => {
        setFatalError(msg);
        setLoading(false);
      },
    });
  };

  const handleFetch = () => {
    const urls = urlText
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!urls.length) {
      setFatalError('Paste at least one deal page URL (one per line).');
      return;
    }
    start(urls);
  };

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!result) return { products: [], comparisons: [] };
    if (!f) return { products: result.products, comparisons: result.comparisons };
    return {
      products: result.products.filter((p) => p.title.toLowerCase().includes(f)),
      comparisons: result.comparisons.filter(
        (g) =>
          g.representativeTitle.toLowerCase().includes(f) ||
          g.items.some((i) => i.title.toLowerCase().includes(f)),
      ),
    };
  }, [result, filter]);

  const statusList = Object.values(statuses);
  const storeCount = result ? new Set(result.products.map((p) => p.sourceSite)).size : 0;
  const bestDiscount = result
    ? Math.max(0, ...result.products.map((p) => p.discountPercentage ?? 0))
    : 0;

  return (
    <div className="min-h-screen bg-zinc-950 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-zinc-900 via-zinc-950 to-zinc-950">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        {/* Header */}
        <header className="mb-8 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-400">
            <Zap className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">FlashDeal Radar</h1>
            <p className="text-sm text-zinc-500">
              On-demand flash-deal scraping &amp; cross-store price comparison
            </p>
          </div>
        </header>

        {/* Input */}
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Deal page URLs — one per line
          </label>
          <textarea
            value={urlText}
            onChange={(e) => setUrlText(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder={'https://chaldal.com/popular\nhttps://www.pickaboo.com/product/walton-ac'}
            className="w-full resize-y rounded-xl border border-zinc-800 bg-zinc-950 p-3 font-mono text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-amber-500/50"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={handleFetch}
              disabled={loading}
              className="flex items-center gap-2 rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-zinc-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
              {loading ? 'Scraping live…' : 'Fetch Live Deals'}
            </button>
            <button
              onClick={() => setUrlText(SAMPLE_URLS.join('\n'))}
              className="flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-300 transition hover:bg-zinc-800"
            >
              <Sparkles className="h-4 w-4" />
              Load sample URLs
            </button>
            {result && (
              <span className="ml-auto text-xs text-zinc-500">
                Last run: {result.products.length} deals · {storeCount} stores ·{' '}
                {(result.totalDurationMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>
        </section>

        {/* Fatal error */}
        {fatalError && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {fatalError}
          </div>
        )}

        {/* Live status */}
        <div className="mt-4">
          <StatusFeed statuses={statusList} />
        </div>

        {/* Results */}
        {result && (
          <>
            {/* Stats */}
            <section className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat icon={<Flame className="h-4 w-4 text-rose-400" />} label="Deals found" value={String(result.products.length)} />
              <Stat icon={<Store className="h-4 w-4 text-sky-400" />} label="Stores" value={String(storeCount)} />
              <Stat icon={<GitCompareArrows className="h-4 w-4 text-violet-400" />} label="Price matches" value={String(result.comparisons.length)} />
              <Stat icon={<Percent className="h-4 w-4 text-emerald-400" />} label="Best discount" value={`${bestDiscount}%`} />
            </section>

            {/* Toolbar */}
            <section className="mt-6 flex flex-wrap items-center gap-2">
              <div className="relative min-w-56 flex-1">
                <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter products… (e.g. rice, iphone, detergent)"
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-900/60 py-2 pl-9 pr-3 text-sm outline-none placeholder:text-zinc-600 focus:border-amber-500/50"
                />
              </div>
              <div className="flex overflow-hidden rounded-xl border border-zinc-800">
                <ViewButton active={view === 'grid'} onClick={() => setView('grid')} icon={<LayoutGrid className="h-4 w-4" />} label="All deals" />
                <ViewButton active={view === 'compare'} onClick={() => setView('compare')} icon={<GitCompareArrows className="h-4 w-4" />} label="Compare" />
              </div>
            </section>

            {/* Content */}
            <section className="mt-4">
              {view === 'grid' ? (
                filtered.products.length ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                    {filtered.products.map((p) => (
                      <ProductCard key={p.id} p={p} />
                    ))}
                  </div>
                ) : (
                  <EmptyNote text="No products match your filter." />
                )
              ) : (
                <ComparisonView groups={filtered.comparisons} />
              )}
            </section>
          </>
        )}

        {/* Idle empty state */}
        {!result && !loading && !fatalError && (
          <div className="mt-16 flex flex-col items-center gap-3 text-center text-zinc-600">
            <Timer className="h-10 w-10" />
            <p className="max-w-md text-sm">
              Paste deal-page URLs above and hit <strong>Fetch Live Deals</strong>. The engine
              detects each site&apos;s architecture (SSR vs CSR), scrapes it with the fastest
              method, normalizes prices, and groups matching products across stores.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-3">
      {icon}
      <div>
        <div className="text-lg font-bold leading-none">{value}</div>
        <div className="mt-1 text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      </div>
    </div>
  );
}

function ViewButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 text-sm font-semibold transition ${
        active ? 'bg-zinc-800 text-amber-400' : 'text-zinc-400 hover:text-zinc-200'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function EmptyNote({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-zinc-800 p-10 text-center text-sm text-zinc-500">
      {text}
    </div>
  );
}
