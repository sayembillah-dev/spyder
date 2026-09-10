import {
  AlertTriangle,
  Bookmark,
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
import { registryList, streamScrape } from './api';
import { ComparisonView } from './components/ComparisonView';
import { DiscoveryPanel } from './components/DiscoveryPanel';
import { ProductCard } from './components/ProductCard';
import { SavedPages } from './components/SavedPages';
import { StatusFeed } from './components/StatusFeed';
import type { DiscoveryReport, ScrapeResult, SiteStatusEvent } from './types';

const SAMPLE_TARGETS = ['chaldal.com', 'https://www.pickaboo.com/product/walton-ac'];

type View = 'grid' | 'compare';
type Tab = 'deals' | 'saved';

export default function App() {
  const [tab, setTab] = useState<Tab>('deals');
  const [urlText, setUrlText] = useState('');
  const [loading, setLoading] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, SiteStatusEvent>>({});
  const [discoveryReports, setDiscoveryReports] = useState<DiscoveryReport[]>([]);
  const [result, setResult] = useState<ScrapeResult | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<View>('grid');
  /** Human corrections — written into discovery.include/.exclude (D8.1). */
  const [include, setInclude] = useState<string[]>([]);
  const [exclude, setExclude] = useState<string[]>([]);
  const [minDiscount, setMinDiscount] = useState('');
  const closeRef = useRef<(() => void) | null>(null);

  /**
   * Saved-list mode (targets: []) fails server-side with a 400 when the list
   * is empty — but EventSource can't read a 400's body, so pre-flight the
   * registry and deliver that message ourselves.
   */
  const start = (targets: string[]) => {
    if (targets.length === 0) {
      registryList({ status: ['active', 'pinned'], limit: 1 })
        .then(({ total }) => {
          if (total === 0) {
            setFatalError(
              'Your saved list is empty — run a discovery on a domain, or add pages by hand in Saved Pages.',
            );
            setTab('saved');
          } else {
            reallyStart(targets);
          }
        })
        .catch(() => reallyStart(targets)); // check failed — let the stream try anyway
      return;
    }
    reallyStart(targets);
  };

  const reallyStart = (targets: string[]) => {
    closeRef.current?.();
    setLoading(true);
    setStatuses({});
    setDiscoveryReports([]);
    setResult(null);
    setFatalError(null);
    setTab('deals');
    const minDiscountPercent = Number(minDiscount);
    closeRef.current = streamScrape(
      targets,
      {
        onStatus: (e) => setStatuses((prev) => ({ ...prev, [e.url]: e })),
        onDiscovery: (r) =>
          setDiscoveryReports((prev) => [...prev.filter((p) => p.domain !== r.domain), r]),
        onDone: (r) => {
          // Late 'done' carries every report again — merge so a missed
          // 'discovery' event can't leave the panel empty.
          setDiscoveryReports((prev) => {
            const merged = new Map(prev.map((p) => [p.domain, p]));
            for (const d of r.discovery ?? []) merged.set(d.domain, d);
            return [...merged.values()];
          });
          setResult(r);
          setLoading(false);
        },
        onError: (msg) => {
          setFatalError(msg);
          setLoading(false);
        },
      },
      {
        ...(include.length ? { include } : {}),
        ...(exclude.length ? { exclude } : {}),
        ...(minDiscountPercent > 0 ? { minDiscountPercent } : {}),
      },
    );
  };

  const handleFetch = () => {
    const targets = urlText
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!targets.length) {
      setFatalError(
        'Type at least one domain or deal-page URL (one per line) — a bare domain like chaldal.com is enough.',
      );
      return;
    }
    start(targets);
  };

  /** Pin → include next run (and un-exclude). A toggle, so a second click undoes. */
  const handlePin = (url: string) => {
    setInclude((prev) => (prev.includes(url) ? prev.filter((u) => u !== url) : [...prev, url]));
    setExclude((prev) => prev.filter((u) => u !== url));
  };
  const handleExclude = (url: string) => {
    setExclude((prev) => (prev.includes(url) ? prev.filter((u) => u !== url) : [...prev, url]));
    setInclude((prev) => prev.filter((u) => u !== url));
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
        <header className="mb-6 flex flex-wrap items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-400">
            <Zap className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">FlashDeal Radar</h1>
            <p className="text-sm text-zinc-500">
              Give it a domain — it finds the deal pages, scrapes them, compares prices
            </p>
          </div>
          <nav className="ml-auto flex overflow-hidden rounded-xl border border-zinc-800">
            <TabButton
              active={tab === 'deals'}
              onClick={() => setTab('deals')}
              icon={<Flame className="h-4 w-4" />}
              label="Deals"
            />
            <TabButton
              active={tab === 'saved'}
              onClick={() => setTab('saved')}
              icon={<Bookmark className="h-4 w-4" />}
              label="Saved Pages"
            />
          </nav>
        </header>

        {tab === 'saved' ? (
          <SavedPages onScrapeSavedList={() => start([])} scraping={loading} />
        ) : (
          <>
            {/* Input */}
            <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
              <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Domains or deal-page URLs — one per line
              </label>
              <textarea
                value={urlText}
                onChange={(e) => setUrlText(e.target.value)}
                rows={3}
                spellCheck={false}
                placeholder={'chaldal.com\ndaraz.com.bd'}
                className="w-full resize-y rounded-xl border border-zinc-800 bg-zinc-950 p-3 font-mono text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-amber-500/50"
              />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  onClick={handleFetch}
                  disabled={loading}
                  className="flex items-center gap-2 rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-zinc-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Rocket className="h-4 w-4" />
                  )}
                  {loading ? 'Working…' : 'Find & Fetch Deals'}
                </button>
                <button
                  onClick={() => setUrlText(SAMPLE_TARGETS.join('\n'))}
                  className="flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-300 transition hover:bg-zinc-800"
                >
                  <Sparkles className="h-4 w-4" />
                  Load samples
                </button>
                <label className="flex items-center gap-1.5 text-xs text-zinc-500">
                  Only ≥
                  <input
                    value={minDiscount}
                    onChange={(e) => setMinDiscount(e.target.value.replace(/[^0-9]/g, ''))}
                    placeholder="0"
                    inputMode="numeric"
                    className="w-14 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-center text-sm outline-none focus:border-amber-500/50"
                  />
                  % off
                </label>
                {(include.length > 0 || exclude.length > 0) && (
                  <span className="text-xs text-zinc-500">
                    {include.length > 0 && `📌 ${include.length} pinned`}
                    {include.length > 0 && exclude.length > 0 && ' · '}
                    {exclude.length > 0 && `🚫 ${exclude.length} excluded`}
                    {' — applied to the next run'}
                  </span>
                )}
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

            {/* Live status — discovery has its own phases now */}
            <div className="mt-4">
              <StatusFeed statuses={statusList} />
            </div>

            {/* Discovery panels — one per domain */}
            {discoveryReports.length > 0 && (
              <div className="mt-4 space-y-3">
                {discoveryReports.map((r) => (
                  <DiscoveryPanel
                    key={r.domain}
                    report={r}
                    include={include}
                    exclude={exclude}
                    onPin={handlePin}
                    onExclude={handleExclude}
                  />
                ))}
              </div>
            )}

            {/* Results */}
            {result && (
              <>
                {/* Stats */}
                <section className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat
                    icon={<Flame className="h-4 w-4 text-rose-400" />}
                    label="Deals found"
                    value={String(result.products.length)}
                  />
                  <Stat
                    icon={<Store className="h-4 w-4 text-sky-400" />}
                    label="Stores"
                    value={String(storeCount)}
                  />
                  <Stat
                    icon={<GitCompareArrows className="h-4 w-4 text-violet-400" />}
                    label="Price matches"
                    value={String(result.comparisons.length)}
                  />
                  <Stat
                    icon={<Percent className="h-4 w-4 text-emerald-400" />}
                    label="Best discount"
                    value={`${bestDiscount}%`}
                  />
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
                    <ViewButton
                      active={view === 'grid'}
                      onClick={() => setView('grid')}
                      icon={<LayoutGrid className="h-4 w-4" />}
                      label="All deals"
                    />
                    <ViewButton
                      active={view === 'compare'}
                      onClick={() => setView('compare')}
                      icon={<GitCompareArrows className="h-4 w-4" />}
                      label="Compare"
                    />
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
                  Type a <strong>domain</strong> — <code>chaldal.com</code> is enough. The engine
                  discovers its deal pages (nav, sitemap, platform probes), verifies each with a
                  real fetch, and scrapes the winners. Or open{' '}
                  <strong>Saved Pages</strong> and hit <strong>Scrape my list</strong>.
                </p>
              </div>
            )}
          </>
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

function TabButton({
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
