import { formatDate, formatPerShare, formatPrice, formatSignedPercent, formatTime, formatUsd, type TickerSnapshot } from '@verifi/check-core';

interface TickerCardProps {
  snapshot: TickerSnapshot | undefined;
  loading: boolean;
  /** Filings on or before this date (YYYY-MM-DD) were already seen on this device. */
  seenThrough: string;
}

const TIMING = { before_open: 'before the open', after_close: 'after the close' } as const;
const OUTCOME = { beat: 'Beat estimates', miss: 'Missed estimates', in_line: 'Met estimates' } as const;

/** Today's numbers and new filings for a followed ticker. */
export function TickerCard({ snapshot: s, loading, seenThrough }: TickerCardProps) {
  if (!s) {
    return (
      <p className="rounded-xl bg-ground px-3 py-2.5 text-[13px] text-muted">
        {loading ? "Loading today's numbers…" : "Today's numbers aren't available right now."}
      </p>
    );
  }

  const up = (s.dayChangePercent ?? 0) >= 0;
  const outcomeClass = s.lastEarnings?.outcome === 'beat' ? 'text-holds' : s.lastEarnings?.outcome === 'miss' ? 'text-contra' : 'text-ink';

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-2 rounded-xl bg-ground p-3">
        {s.price !== null ? (
          <div className="flex items-baseline justify-between gap-2">
            <span className="flex items-baseline gap-2">
              <span className="text-[22px] font-extrabold text-ink">{formatPrice(s.price)}</span>
              {s.dayChangePercent !== null && (
                <span className={`text-sm font-bold ${up ? 'text-holds' : 'text-contra'}`}>{formatSignedPercent(s.dayChangePercent)} today</span>
              )}
            </span>
            {s.marketCap !== null && <span className="text-xs text-muted">{formatUsd(s.marketCap)} value</span>}
          </div>
        ) : (
          <p className="text-[13px] text-muted">{s.unavailable.includes('market') ? "Price isn't available right now." : 'No price data for this ticker.'}</p>
        )}

        <dl className="flex flex-col gap-1.5 text-[13px]">
          <div className="flex justify-between gap-3">
            <dt className="text-body">Next earnings</dt>
            <dd className="text-right font-semibold text-ink">
              {s.nextEarnings ? `${formatDate(s.nextEarnings.date)}${s.nextEarnings.timing ? `, ${TIMING[s.nextEarnings.timing]}` : ''}` : 'Not announced'}
            </dd>
          </div>
          {s.lastEarnings && (
            <div className="flex justify-between gap-3">
              <dt className="text-body">{s.lastEarnings.label}</dt>
              <dd className="text-right">
                <span className={`font-semibold ${outcomeClass}`}>{s.lastEarnings.outcome ? OUTCOME[s.lastEarnings.outcome] : 'Reported'}</span>
                <span className="block text-xs text-muted">
                  EPS {formatPerShare(s.lastEarnings.actual)}
                  {s.lastEarnings.estimate !== null && ` vs est. ${formatPerShare(s.lastEarnings.estimate)}`}
                </span>
              </dd>
            </div>
          )}
        </dl>
      </div>

      <div className="flex flex-col">
        <h3 className="pb-1 text-xs font-bold tracking-wider text-muted">SEC FILINGS, LAST 45 DAYS</h3>
        {s.filings.length === 0 ? (
          <p className="text-[13px] text-muted">{s.unavailable.includes('filings') ? "Filings aren't available right now." : 'None.'}</p>
        ) : (
          s.filings.map((f) => (
            <a
              key={f.url}
              href={f.url}
              target="_blank"
              rel="noreferrer"
              className="flex min-h-10 items-center justify-between gap-2 border-t border-line text-[13px] text-ink no-underline first:border-0"
            >
              <span className="flex min-w-0 items-center gap-2">
                {f.filed > seenThrough && <span className="shrink-0 rounded bg-teal-soft px-1.5 py-0.5 text-[11px] font-bold text-teal-deep">NEW</span>}
                <span className="truncate font-semibold">{f.label}</span>
                <span className="shrink-0 text-xs text-muted">{f.form}</span>
              </span>
              <span className="shrink-0 text-xs text-muted">{formatDate(f.filed)}</span>
            </a>
          ))
        )}
      </div>

      {s.priceAt && <p className="text-[11px] text-muted">Price as of {formatTime(s.priceAt)}. Market data: Finnhub. Filings: SEC.</p>}
    </div>
  );
}
