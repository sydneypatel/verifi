import { addDays, newYorkDate } from '../../dates';
import type { AlpacaBar, AlpacaClient } from './client';

// Daily and intraday prices from the past, so a move can be measured on the
// post's own day instead of the day of the check.

/** One trading day. */
export interface DailyBar {
  /** YYYY-MM-DD, New York. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** A few minutes of trading, with its New York date and minute of the day. */
export interface IntradayBar {
  date: string;
  /** Minutes since midnight in New York: 570 is 9:30 AM. */
  minute: number;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PriceHistory {
  /** Shown in citations, e.g. "Alpaca (SIP)". */
  label(): string;
  /** Every trading day on record, oldest first. Null when the symbol has none. */
  daily(ticker: string): Promise<DailyBar[] | null>;
  /** One day's 5-minute bars, including pre-market and after-hours trades when the feed has them. */
  intraday(ticker: string, date: string): Promise<IntradayBar[]>;
}

/** Alpaca's free history starts in 2016. A company first traded later has its full history on record. */
export const HISTORY_START = '2016-01-01';

const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function nyMinute(at: Date): number {
  const parts = clock.formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return n('hour') * 60 + n('minute');
}

/** A daily bar's trading day. Alpaca stamps it at midnight New York (04:00 or 05:00 UTC); a bare UTC midnight is taken as written. */
export function barDate(t: string): string {
  return /T00:00:00(?:\.0+)?Z$/.test(t) ? t.slice(0, 10) : newYorkDate(new Date(t));
}

const toDaily = (b: AlpacaBar): DailyBar => ({ date: barDate(b.t), open: b.o, high: b.h, low: b.l, close: b.c });

export function createAlpacaHistory({ alpaca, now = () => new Date() }: { alpaca: AlpacaClient; now?: () => Date }): PriceHistory {
  // Past days never change, so a ticker's history is fetched once per half hour
  // (the newest day can still move) and shared by every check.
  const daily = new Map<string, { at: number; value: Promise<DailyBar[] | null> }>();
  const intraday = new Map<string, { at: number; value: Promise<IntradayBar[]> }>();
  const DAILY_MS = 30 * 60 * 1000;

  // The free plan serves full-market data up to 15 minutes ago.
  const latestEnd = () => new Date(now().getTime() - 16 * 60 * 1000).toISOString();
  const trim = <T>(map: Map<string, T>) => {
    if (map.size > 200) map.delete(map.keys().next().value!);
  };

  return {
    label: () => `Alpaca (${alpaca.feed.toUpperCase()})`,

    daily(ticker) {
      const key = ticker.toUpperCase();
      const hit = daily.get(key);
      if (hit && now().getTime() - hit.at < DAILY_MS) return hit.value;
      const value = alpaca.bars(key, { timeframe: '1Day', start: HISTORY_START, end: latestEnd() }).then((bars) => (bars.length ? bars.map(toDaily) : null));
      daily.set(key, { at: now().getTime(), value });
      value.catch(() => daily.delete(key));
      trim(daily);
      return value;
    },

    intraday(ticker, date) {
      const key = `${ticker.toUpperCase()}:${date}`;
      const settled = date < newYorkDate(now());
      const hit = intraday.get(key);
      if (hit && (settled || now().getTime() - hit.at < 5 * 60 * 1000)) return hit.value;
      // 08:00 UTC is 3 or 4 AM in New York, before pre-market opens; 02:00 UTC the next day is after it closes.
      const end = `${addDays(date, 1)}T02:00:00Z`;
      const value = alpaca
        .bars(ticker.toUpperCase(), { timeframe: '5Min', start: `${date}T08:00:00Z`, end: end < latestEnd() ? end : latestEnd() })
        .then((bars) =>
          bars
            .map((b) => {
              const at = new Date(b.t);
              return { date: newYorkDate(at), minute: nyMinute(at), time: b.t, open: b.o, high: b.h, low: b.l, close: b.c };
            })
            .filter((b) => b.date === date),
        );
      intraday.set(key, { at: now().getTime(), value });
      value.catch(() => intraday.delete(key));
      trim(intraday);
      return value;
    },
  };
}
