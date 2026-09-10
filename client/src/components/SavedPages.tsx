import {
  Ban,
  Check,
  Download,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  registryAdd,
  registryDelete,
  registryExportUrl,
  registryImport,
  registryList,
  registryPatch,
  registryRefresh,
  registryRefreshAll,
} from '../api';
import type { DealPageRecord, RegistryStatus, VerificationResult } from '../types';
import { ConfidenceDot } from './StatusFeed';

interface Props {
  /** "Scrape my list" — POST /api/scrape with targets: [] (D8.2). */
  onScrapeSavedList: () => void;
  scraping: boolean;
}

const STATUS_CHIP: Record<RegistryStatus, string> = {
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  pinned: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
  stale: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
  parked: 'border-zinc-700 bg-zinc-800/60 text-zinc-400',
  excluded: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  candidate: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
};

const FILTERS: Array<RegistryStatus | 'all'> = [
  'all',
  'active',
  'pinned',
  'stale',
  'parked',
  'excluded',
];

/** "3h ago" / "in 2d" / "just now". */
export function fmtWhen(ts: number | null): string {
  if (ts == null) return '—';
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 60_000) return 'just now';
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  return rtf.format(Math.round(diff / 86_400_000), 'day');
}

/** Parked rows wake at a season, not a moment: "waking Nov 2026". */
function wakingAt(ts: number): string {
  return `waking ${new Date(ts).toLocaleString('en-US', { month: 'short', year: 'numeric' })}`;
}

function verdictLine(v: VerificationResult): string {
  return `${v.productCount} products · ${Math.round(v.dealDensity * 100)}% discounted${
    v.rejectedReason ? ` ❌ ${v.rejectedReason}` : ' ✅'
  }`;
}

/** The registry, made visible (D8.2). */
export function SavedPages({ onScrapeSavedList, scraping }: Props) {
  const [records, setRecords] = useState<DealPageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RegistryStatus | 'all'>('all');
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; label: string; notes: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      const { records } = await registryList({ sort: 'nextCheckAt', limit: 500 });
      setRecords(records);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the saved list');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const say = (id: string, msg: string) => {
    setRowMsg((prev) => ({ ...prev, [id]: msg }));
    setTimeout(() => setRowMsg((prev) => ({ ...prev, [id]: '' })), 6000);
  };

  const act = async (id: string, fn: () => Promise<unknown>, okMsg: string) => {
    setBusyId(id);
    try {
      await fn();
      say(id, okMsg);
    } catch (e) {
      say(id, `❌ ${e instanceof Error ? e.message : 'failed'}`);
    } finally {
      setBusyId(null);
      void reload();
    }
  };

  const scrapeable = records.filter((r) => r.status === 'active' || r.status === 'pinned');

  const groups = useMemo(() => {
    const visible = records.filter((r) => filter === 'all' || r.status === filter);
    const byDomain = new Map<string, DealPageRecord[]>();
    for (const r of visible) {
      const list = byDomain.get(r.domain) ?? [];
      list.push(r);
      byDomain.set(r.domain, list);
    }
    return [...byDomain.entries()];
  }, [records, filter]);

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-bold tracking-tight">Saved Pages</h2>
        <span className="text-xs text-zinc-500">
          {records.length} saved · {scrapeable.length} scrapeable
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            onClick={onScrapeSavedList}
            disabled={scraping || !scrapeable.length}
            className="flex items-center gap-2 rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-zinc-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            title="POST /api/scrape with targets: [] — scrape every active + pinned page"
          >
            {scraping ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Scrape my list
          </button>
          <button
            onClick={async () => {
              setNotice(null);
              try {
                const r = await registryRefreshAll();
                const ok = r.results.filter((x) => x.outcome === 'ok').length;
                const changed = r.results.filter((x) => x.fingerprintChanged).length;
                setNotice(`Checked ${r.checked} due: ${ok} ok, ${changed} changed`);
                void reload();
              } catch (e) {
                setNotice(`❌ ${e instanceof Error ? e.message : 'refresh failed'}`);
              }
            }}
            className="flex items-center gap-1.5 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-800"
            title="Verify everything whose nextCheckAt is due (one cheap fetch each)"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Refresh due
          </button>
          <a
            href={registryExportUrl('json')}
            download="deal-pages.json"
            className="flex items-center gap-1.5 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-800"
          >
            <Download className="h-3.5 w-3.5" /> JSON
          </a>
          <a
            href={registryExportUrl('csv')}
            download="deal-pages.csv"
            className="flex items-center gap-1.5 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-800"
          >
            <Download className="h-3.5 w-3.5" /> CSV
          </a>
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-800"
            title="Import a previously exported JSON file (never clobbers pinned/excluded)"
          >
            <Upload className="h-3.5 w-3.5" /> Import
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setNotice(null);
              try {
                const parsed: unknown = JSON.parse(await file.text());
                const r = await registryImport(parsed);
                setNotice(`Imported: ${r.added} added, ${r.skipped} kept (pinned/excluded win)`);
                void reload();
              } catch (err) {
                setNotice(`❌ Import failed: ${err instanceof Error ? err.message : 'bad file'}`);
              }
            }}
          />
        </div>
      </div>

      {notice && <p className="mt-2 text-xs text-zinc-400">{notice}</p>}

      {/* Add by hand — verified inline before it's saved */}
      <AddByHand
        onSaved={() => {
          void reload();
        }}
      />

      {/* Status filter */}
      <div className="mt-3 flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-lg border px-2.5 py-1 text-xs font-semibold capitalize transition ${
              filter === f
                ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {f}
            {f !== 'all' && ` (${records.filter((r) => r.status === f).length})`}
          </button>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <p className="mt-6 flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading saved pages…
        </p>
      ) : error ? (
        <p className="mt-6 text-sm text-rose-300">❌ {error}</p>
      ) : !groups.length ? (
        <p className="mt-6 rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
          Nothing here yet — run a discovery on a domain, or add a deal page by hand above.
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {groups.map(([domain, rows]) => (
            <div key={domain}>
              <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-zinc-500">
                {domain}
              </h3>
              <ul className="space-y-1.5">
                {rows.map((r) => (
                  <RecordRow
                    key={r.id}
                    r={r}
                    busy={busyId === r.id}
                    msg={rowMsg[r.id] ?? ''}
                    editing={editing?.id === r.id ? editing : null}
                    onEdit={() =>
                      setEditing({ id: r.id, label: r.label ?? '', notes: r.notes ?? '' })
                    }
                    onEditChange={setEditing}
                    onEditSave={() =>
                      act(
                        r.id,
                        () =>
                          registryPatch(r.id, {
                            label: editing?.label.trim() || null,
                            notes: editing?.notes.trim() || null,
                          }),
                        '✅ saved',
                      ).then(() => setEditing(null))
                    }
                    onEditCancel={() => setEditing(null)}
                    onPin={() =>
                      act(
                        r.id,
                        () =>
                          registryPatch(r.id, {
                            status: r.status === 'pinned' ? 'active' : 'pinned',
                          }),
                        r.status === 'pinned' ? '📌 unpinned' : '📌 pinned',
                      )
                    }
                    onExclude={() =>
                      act(
                        r.id,
                        () =>
                          registryPatch(r.id, {
                            status: r.status === 'excluded' ? 'active' : 'excluded',
                          }),
                        r.status === 'excluded' ? '↩️ un-excluded' : '🚫 excluded',
                      )
                    }
                    onRefresh={() =>
                      act(
                        r.id,
                        async () => {
                          const res = await registryRefresh(r.id);
                          say(
                            r.id,
                            res.verification.rejectedReason
                              ? `❌ ${res.verification.rejectedReason}`
                              : `✅ ${verdictLine(res.verification)}${
                                  res.fingerprintChanged ? ' · products changed' : ''
                                }`,
                          );
                        },
                        '',
                      )
                    }
                    onDelete={() => {
                      if (window.confirm(`Delete ${r.url} from the saved list?`)) {
                        void act(r.id, () => registryDelete(r.id), '🗑️ deleted');
                      }
                    }}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AddByHand({ onSaved }: { onSaved: () => void }) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<string | null>(null);
  const [ok, setOk] = useState<boolean>(false);

  const submit = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setVerdict(null);
    try {
      const res = await registryAdd(url.trim(), label.trim() || undefined);
      setOk(res.ok);
      if (res.ok) {
        setVerdict(
          `${res.existed ? 'Already saved' : 'Saved'} as ${res.record?.status}${
            res.verification ? ` — ${verdictLine(res.verification)}` : ''
          }`,
        );
        setUrl('');
        setLabel('');
        onSaved();
      } else {
        setVerdict(
          `Not saved: ${res.error}${
            res.verification ? ` (${verdictLine(res.verification)})` : ''
          }`,
        );
      }
    } catch (e) {
      setOk(false);
      setVerdict(`❌ ${e instanceof Error ? e.message : 'failed'}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          placeholder="Add a deal page by hand: https://shop.com/clearance"
          spellCheck={false}
          className="min-w-64 flex-1 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm outline-none placeholder:text-zinc-600 focus:border-amber-500/50"
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          placeholder="Label (optional)"
          className="w-44 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-amber-500/50"
        />
        <button
          onClick={() => void submit()}
          disabled={busy || !url.trim()}
          className="flex items-center gap-1.5 rounded-xl border border-zinc-700 px-3 py-2 text-sm font-semibold text-zinc-200 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          title="Verified before it's saved — a bad URL is an error here, not a bad row"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Add
        </button>
      </div>
      {verdict && (
        <p className={`mt-1.5 text-xs ${ok ? 'text-emerald-300' : 'text-rose-300'}`}>{verdict}</p>
      )}
    </div>
  );
}

function RecordRow({
  r,
  busy,
  msg,
  editing,
  onEdit,
  onEditChange,
  onEditSave,
  onEditCancel,
  onPin,
  onExclude,
  onRefresh,
  onDelete,
}: {
  r: DealPageRecord;
  busy: boolean;
  msg: string;
  editing: { id: string; label: string; notes: string } | null;
  onEdit: () => void;
  onEditChange: (v: { id: string; label: string; notes: string }) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  onPin: () => void;
  onExclude: () => void;
  onRefresh: () => void;
  onDelete: () => void;
}) {
  const parked = r.status === 'parked';
  const excluded = r.status === 'excluded';
  const iconBtn =
    'shrink-0 rounded-lg border border-zinc-800 p-1.5 text-zinc-500 transition hover:text-zinc-200 disabled:opacity-40';

  return (
    <li
      className={`rounded-xl border px-3 py-2 ${
        parked || excluded
          ? 'border-zinc-800/50 bg-zinc-950/30 opacity-60'
          : 'border-zinc-800 bg-zinc-950/60'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATUS_CHIP[r.status]}`}
        >
          {r.status}
        </span>
        <div className="min-w-0 flex-1">
          <span className="text-sm font-semibold text-zinc-200">
            {r.label ?? <span className="font-normal italic text-zinc-500">(no label)</span>}
          </span>{' '}
          <a
            href={r.url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-zinc-500 hover:text-zinc-300"
          >
            {r.url.replace(/^https?:\/\//, '')}
          </a>
        </div>
        {/* Deal density reuses the confidence dot (D8.1) */}
        <span
          className="hidden shrink-0 items-center gap-1.5 text-xs text-zinc-400 sm:flex"
          title={`deal density ${Math.round(r.dealDensity * 100)}% · avg ${Math.round(
            r.avgProductCount,
          )} products · score ${r.finalScore.toFixed(2)}`}
        >
          <ConfidenceDot score={r.dealDensity} />
          {Math.round(r.dealDensity * 100)}% · ~{Math.round(r.avgProductCount)}
        </span>
        <span className="hidden w-20 shrink-0 text-right text-xs text-zinc-500 md:block">
          {parked && r.revisitAfter ? (
            <span title={new Date(r.revisitAfter).toLocaleDateString()}>{wakingAt(r.revisitAfter)}</span>
          ) : (
            <span title="next scheduled check">{fmtWhen(r.nextCheckAt)}</span>
          )}
        </span>
        {busy ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-zinc-500" />
        ) : (
          <>
            <button
              onClick={onPin}
              className={iconBtn}
              title={r.status === 'pinned' ? 'Unpin (back to active)' : 'Pin — never auto-demote'}
            >
              {r.status === 'pinned' ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            </button>
            <button
              onClick={onExclude}
              className={iconBtn}
              title={excluded ? 'Un-exclude (back to active)' : 'Exclude — a remembered "no"'}
            >
              {excluded ? <Undo2 className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
            </button>
            <button onClick={onRefresh} className={iconBtn} title="Refresh now — verify + scrape">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button onClick={onEdit} className={iconBtn} title="Edit label & notes">
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button onClick={onDelete} className={iconBtn} title="Delete — forget this page entirely">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
      {msg && <p className="mt-1 text-xs text-zinc-400">{msg}</p>}
      {editing && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-800/60 pt-2">
          <input
            value={editing.label}
            onChange={(e) => onEditChange({ ...editing, label: e.target.value })}
            placeholder="Label — e.g. Eid Flash Sale"
            className="w-52 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm outline-none placeholder:text-zinc-600 focus:border-amber-500/50"
          />
          <input
            value={editing.notes}
            onChange={(e) => onEditChange({ ...editing, notes: e.target.value })}
            placeholder="Notes (optional)"
            className="min-w-48 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm outline-none placeholder:text-zinc-600 focus:border-amber-500/50"
          />
          <button
            onClick={onEditSave}
            className="flex items-center gap-1 rounded-lg bg-emerald-500/15 px-2.5 py-1.5 text-xs font-bold text-emerald-300 hover:bg-emerald-500/25"
          >
            <Check className="h-3.5 w-3.5" /> Save
          </button>
          <button
            onClick={onEditCancel}
            className="flex items-center gap-1 rounded-lg border border-zinc-800 px-2.5 py-1.5 text-xs font-semibold text-zinc-400 hover:text-zinc-200"
          >
            <X className="h-3.5 w-3.5" /> Cancel
          </button>
        </div>
      )}
    </li>
  );
}
