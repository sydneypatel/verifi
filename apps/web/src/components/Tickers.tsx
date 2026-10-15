import { useState } from 'react';
import { tickersOf } from '../post';
import type { HistoryEntry } from '../storage';
import { TopBar, VerdictBadge } from './ui';

interface TickersProps {
  entries: HistoryEntry[];
  followed: string[];
  onFollow: (ticker: string) => void;
  onUnfollow: (ticker: string) => void;
  onOpenClaim: (entryId: string, index: number) => void;
}

interface TickerRow {
  ticker: string;
  name: string | null;
  checks: HistoryEntry[];
  following: boolean;
}

export function Tickers({ entries, followed, onFollow, onUnfollow, onOpenClaim }: TickersProps) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Every followed ticker, plus every ticker you have checked a post about.
  const rows = new Map<string, TickerRow>();
  for (const t of followed) rows.set(t, { ticker: t, name: null, checks: [], following: true });
  for (const e of entries) {
    for (const t of tickersOf(e.result)) {
      const row = rows.get(t) ?? { ticker: t, name: null, checks: [], following: false };
      row.name ??= e.result.claims.find((c) => c.claim.ticker === t && c.evidence)?.evidence?.entityName ?? (tickersOf(e.result).length === 1 ? e.result.entityName : null);
      row.checks.push(e);
      rows.set(t, row);
    }
  }
  const list = [...rows.values()].sort((a, b) => b.checks.length - a.checks.length || a.ticker.localeCompare(b.ticker));

  function submit() {
    const t = input.trim().replace(/^\$/, '').toUpperCase();
    if (!/^[A-Z]{1,5}([.-][A-Z])?$/.test(t)) {
      setError('Enter a ticker like AAPL or NVDA.');
      return;
    }
    setError(null);
    onFollow(t);
    setInput('');
  }

  return (
    <>
      <TopBar
        left={<span className="pl-3 text-xl font-extrabold tracking-tight text-navy">Tickers</span>}
        right={<span className="mr-3 text-[13px] text-muted">Stocks you follow</span>}
      />

      <div className="flex flex-1 flex-col gap-3.5 px-4 pt-4 pb-4">
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex gap-2">
            <div className="flex h-[46px] flex-1 items-center gap-2 rounded-xl border border-dash bg-white px-3">
              <span className="text-[15px] font-bold text-unknown-bar">$</span>
              <label htmlFor="ticker-add" className="sr-only">
                Add a ticker
              </label>
              <input
                id="ticker-add"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Add a ticker, e.g. NVDA"
                autoCapitalize="characters"
                className="flex-1 bg-transparent text-[15px] text-ink uppercase outline-none placeholder:normal-case placeholder:text-muted"
              />
            </div>
            <button type="submit" className="h-[46px] w-[76px] cursor-pointer rounded-xl bg-navy text-sm font-bold text-white">
              Follow
            </button>
          </div>
          {error && <p className="text-[13px] font-medium text-contra">{error}</p>}
        </form>

        {list.length === 0 && (
          <p className="rounded-2xl border border-dashed border-dash p-4 text-sm leading-relaxed text-body">
            Follow a stock, or check a post about one, and it shows up here with every claim you've checked about it.
          </p>
        )}

        {list.map((row) => (
          <section key={row.ticker} className={`flex flex-col gap-3 rounded-2xl bg-white p-3.5 ${row.checks.length ? 'border-2 border-navy' : 'border border-line'}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className={`flex h-10 min-w-10 items-center justify-center rounded-lg px-1 text-xs font-extrabold ${row.checks.length ? 'bg-navy text-white' : 'bg-line text-navy'}`}>
                  {row.ticker}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-base font-bold text-ink">{row.name ?? row.ticker}</span>
                  <span className="text-xs text-muted">
                    {row.checks.length ? `${row.checks.length} ${row.checks.length === 1 ? 'check' : 'checks'}` : 'No checks yet'}
                  </span>
                </span>
              </div>
              {row.following ? (
                <button type="button" onClick={() => onUnfollow(row.ticker)} className="min-h-9 shrink-0 cursor-pointer rounded-lg border border-dash px-2.5 text-xs font-semibold text-body">
                  Following
                </button>
              ) : (
                <button type="button" onClick={() => onFollow(row.ticker)} className="min-h-9 shrink-0 cursor-pointer rounded-lg bg-teal-soft px-2.5 text-xs font-bold text-teal-deep">
                  Follow
                </button>
              )}
            </div>

            {row.checks.length > 0 && (
              <div className="flex flex-col">
                <h3 className="pb-1 text-xs font-bold tracking-wider text-muted">CLAIMS YOU'VE CHECKED</h3>
                {row.checks
                  .flatMap((e) => e.result.claims.map((c, index) => ({ e, c, index })))
                  .filter(({ c }) => c.claim.ticker === row.ticker)
                  .slice(0, 4)
                  .map(({ e, c, index }) => (
                    <button
                      key={`${e.id}-${c.claim.id}`}
                      type="button"
                      onClick={() => onOpenClaim(e.id, index)}
                      className="flex min-h-10 w-full cursor-pointer items-center justify-between gap-2 border-t border-line text-left text-[13px] text-ink first:border-0"
                    >
                      <span className="truncate">"{c.claim.quote}"</span>
                      <VerdictBadge verdict={c.verdict} size="sm" inline />
                    </button>
                  ))}
              </div>
            )}
          </section>
        ))}
        {/* coming soon: */}
        {/* <div className="mt-auto flex items-start gap-2.5 rounded-xl bg-mint px-3.5 py-3">
          <svg width="18" height="18" viewBox="0 0 22 22" fill="none" className="mt-px shrink-0 text-teal-deep" aria-hidden="true">
            <path d="M11 3a5 5 0 0 0-5 5v3.5L4.5 15h13L16 11.5V8a5 5 0 0 0-5-5zM9 18a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="text-[13px] leading-normal text-teal-deep">Coming later: an alert when a company you follow files new results.</p>
        </div> */}
      </div>
    </>
  );
}
