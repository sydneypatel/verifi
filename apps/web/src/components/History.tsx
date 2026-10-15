import { useMemo, useState } from 'react';
import { tickersOf, titleOf } from '../post';
import type { HistoryEntry } from '../storage';
import { Chevron, TopBar, VERDICTS } from './ui';

interface HistoryProps {
  entries: HistoryEntry[];
  onOpen: (id: string) => void;
  onClear: () => void;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'TODAY';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
}

function outcome(e: HistoryEntry): string {
  const { summary } = e.result;
  if (summary.total === 0) return 'No claims found';
  if (summary.checkable === 0) return 'Nothing to check';
  return `${summary.holdsUp} of ${summary.checkable} ${summary.holdsUp === 1 ? 'holds' : 'hold'} up`;
}

export function History({ entries, onOpen, onClear }: HistoryProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => [e.text, ...tickersOf(e.result), e.result.entityName ?? ''].some((s) => s.toLowerCase().includes(q)));
  }, [entries, query]);

  const groups: { day: string; items: HistoryEntry[] }[] = [];
  for (const e of filtered) {
    const day = dayLabel(e.savedAt);
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(e);
    else groups.push({ day, items: [e] });
  }

  return (
    <>
      <TopBar
        left={<span className="pl-3 text-xl font-extrabold tracking-tight text-navy">History</span>}
        right={<span className="mr-3 rounded-xl bg-unknown-soft px-2.5 py-1 text-xs font-semibold text-body">Guest</span>}
      />

      <div className="flex flex-1 flex-col gap-3.5 px-4 pt-4 pb-4">
        <section className="flex flex-col gap-3 rounded-2xl bg-navy p-4 text-white">
          <div className="flex items-start gap-2.5">
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" className="mt-px shrink-0" aria-hidden="true">
              <rect x="3" y="5" width="16" height="11" rx="2" className="stroke-teal-on-navy" strokeWidth="1.8" />
              <path d="M8 19h6" className="stroke-teal-on-navy" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-bold">Saved on this device only</h2>
              <p className="text-[13px] leading-normal text-dash">
                You never need an account to check a post. Accounts, to keep your checks on your phone and laptop, are coming soon.
              </p>
            </div>
          </div>
          <span className="flex h-11 items-center justify-center rounded-xl border border-body text-sm font-semibold text-dash">Accounts coming soon</span>
        </section>

        {entries.length > 0 && (
          <div className="flex h-11 items-center gap-2 rounded-xl border border-dash bg-white px-3">
            <svg width="18" height="18" viewBox="0 0 22 22" fill="none" aria-hidden="true">
              <circle cx="10" cy="10" r="6.5" stroke="#64748B" strokeWidth="1.8" />
              <path d="M15 15l4 4" stroke="#64748B" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <label htmlFor="hist-search" className="sr-only">
              Search your checks
            </label>
            <input
              id="hist-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by ticker or words"
              className="flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
            />
          </div>
        )}

        {entries.length === 0 && (
          <p className="rounded-2xl border border-dashed border-dash p-4 text-sm leading-relaxed text-body">
            No checks yet. Posts you check are saved here automatically.
          </p>
        )}
        {entries.length > 0 && filtered.length === 0 && <p className="px-1 text-sm text-body">No checks match "{query}".</p>}

        {groups.map((g) => (
          <section key={g.day} className="flex flex-col gap-2">
            <h2 className="text-xs font-bold tracking-wider text-muted">{g.day}</h2>
            {g.items.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => onOpen(e.id)}
                className="flex w-full cursor-pointer items-center gap-2 rounded-2xl border border-line bg-white p-3.5 text-left"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-2">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-extrabold tracking-wide text-navy">{titleOf(e.result).subtitle ?? e.result.ticker ?? e.result.entityName ?? 'Post'}</span>
                    <span className="text-xs text-muted">
                      {new Date(e.savedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-sm leading-snug text-strong">"{e.text}"</span>
                  <span className="flex items-center gap-2">
                    <span className="flex h-1.5 w-24 gap-[3px]" aria-hidden="true">
                      {e.result.claims.map((c) => (
                        <span key={c.claim.id} className={`flex-1 rounded ${VERDICTS[c.verdict].bar}`} />
                      ))}
                    </span>
                    <span className="text-xs font-semibold text-body">{outcome(e)}</span>
                  </span>
                </span>
                <Chevron />
              </button>
            ))}
          </section>
        ))}

        {entries.length > 0 && (
          <button type="button" onClick={onClear} className="mt-2 min-h-11 cursor-pointer self-center text-sm font-semibold text-body underline">
            Clear history on this device
          </button>
        )}
      </div>
    </>
  );
}
