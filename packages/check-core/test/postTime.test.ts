// A post's exact time: every price, move and market-value claim in it is measured
// to the last trade before it was made, after hours included.
import { describe, expect, it } from 'vitest';
import { EMPTY_CLAIM, checkPost, createPriceHistorySource } from '../src';
import { newYorkInstant, parsePostTime, postStampInText } from '../src/dates';
import type { DailyBar, IntradayBar, PriceHistory } from '../src/sources/alpaca/history';
import type { ExtractedClaim } from '../src/types';

const NOW = new Date('2026-11-13T15:00:00Z');
const SHARES = 24.1e9;

const daily: DailyBar[] = [
  { date: '2026-11-05', open: 190, high: 191, low: 187, close: 188.2 },
  { date: '2026-11-06', open: 188, high: 189, low: 185, close: 186.64 },
  { date: '2026-11-09', open: 185, high: 186, low: 177, close: 178.67 },
  { date: '2026-11-10', open: 178, high: 179, low: 168, close: 168.89 },
  { date: '2026-11-11', open: 169, high: 175, low: 167, close: 173.73 },
  { date: '2026-11-12', open: 160, high: 162, low: 157, close: 160.1 },
];

// Nov 11: the regular session drifts to a $173.73 close, then the stock plunges after hours.
const bar = (minute: number, close: number): IntradayBar => ({
  date: '2026-11-11',
  minute,
  time: newYorkInstant('2026-11-11', minute),
  open: close,
  high: close + 0.2,
  low: close - 0.2,
  close,
});
const nov11: IntradayBar[] = [
  bar(9 * 60 + 30, 169.5),
  bar(13 * 60 + 55, 170.1), // ends 2:00 PM
  bar(14 * 60 + 30, 172.4),
  bar(15 * 60 + 55, 173.73), // the regular close
  bar(16 * 60 + 30, 168.0),
  bar(18 * 60, 162.5),
  bar(20 * 60, 158.78), // ends 8:05 PM, before the 8:06 PM post
  bar(20 * 60 + 5, 156.9), // ends 8:10 PM, after it
];

const history: PriceHistory = {
  label: () => 'Test prices',
  daily: async () => daily,
  intraday: async (_t, date) => (date === '2026-11-11' ? nov11 : []),
};
// Market value at the latest close (Nov 12), with today's share count.
const finnhub = { profile: async () => ({ name: 'NVIDIA Corporation', marketCapitalization: (SHARES * 160.1) / 1e6 }) } as any;
const sources = [createPriceHistorySource({ history, finnhub, now: () => NOW })];

const ex = (o: Partial<ExtractedClaim>): ExtractedClaim => ({ ...EMPTY_CLAIM, quote: 'q', type: 'price_move', ticker: 'NVDA', ...o });
const POST = 'Nvidia stock is down ~$690 billion this week after plunging in after-hours trading.';
const weekCap = ex({ quote: 'Nvidia stock is down ~$690 billion this week', type: 'market_cap', claimedAmount: 690e9, direction: 'down', window: 'week' });
const afterHours = ex({ quote: 'plunging in after-hours trading', direction: 'down', session: 'after_hours' });
const run = (claims: ExtractedClaim[], postedAt?: string, text = POST) =>
  checkPost(text, { extractor: { name: 'stub', extractClaims: async () => claims }, sources, now: () => NOW }, { postedAt });

describe('reading the post time', () => {
  it('reads clock times, timestamps and minute ages, but not rounded hour ages', () => {
    expect(parsePostTime('8:06 PM · Nov 11, 2026', NOW)).toBe('2026-11-12T01:06:00.000Z');
    expect(parsePostTime('2026-11-11T20:06:00-05:00', NOW)).toBe('2026-11-12T01:06:00.000Z');
    expect(parsePostTime('45m', NOW)).toBe('2026-11-13T14:15:00.000Z');
    expect(parsePostTime('5h', NOW)).toBeNull();
    expect(parsePostTime('Nov 11', NOW)).toBeNull();
  });

  it('reads the time on an X date line in the pasted post', () => {
    expect(postStampInText(`${POST}\n8:06 PM · Nov 11, 2026 · 1.2M Views`, NOW)).toEqual({ day: '2026-11-11', time: '2026-11-12T01:06:00.000Z' });
  });
});

describe('measuring to the price when the post was made', () => {
  it('NVDA at 8:06 PM: the week and the after-hours plunge both end at $158.78', async () => {
    const r = await run([weekCap, afterHours], '8:06 PM · Nov 11, 2026');
    expect(r.postedTime).toBe('2026-11-12T01:06:00.000Z');
    const [week, plunge] = r.claims;
    expect(week!.verdict).toBe('holds_up');
    expect(week!.reason).toContain('the after-hours price of $158.78 at 8:05 PM ET on Nov 11, 2026');
    expect(week!.reason).toMatch(/lost about \$6[6-9]\d\.\dB in market value/);
    expect(plunge!.verdict).toBe('holds_up');
    expect(plunge!.reason).toContain('$158.78');
    expect(week!.evidence?.kind === 'price_history' && week!.evidence.postPrice?.price).toBe(158.78);
  });

  it('NVDA at 2:00 PM: the latest price in the session, not the after-hours one', async () => {
    const r = await run([weekCap, afterHours], '2:00 PM · Nov 11, 2026');
    expect(r.claims[0]!.reason).toContain('the price of $170.10 at 2:00 PM ET');
    expect(r.claims[0]!.reason).not.toContain('158.78');
    expect(r.claims[1]!.verdict).toBe('cant_check');
    expect(r.claims[1]!.reason).toContain('before any after-hours trades');
  });

  it('"closed down 7% this week", posted after the close: the regular close', async () => {
    const closedWeek = ex({ quote: 'NVDA closed down 7% this week', claimedPercent: 7, direction: 'down', window: 'week' });
    const r = await run([closedWeek], '8:06 PM · Nov 11, 2026', 'NVDA closed down 7% this week');
    expect(r.claims[0]!.verdict).toBe('holds_up');
    expect(r.claims[0]!.reason).toContain('$173.73');
    expect(r.claims[0]!.reason).not.toContain('after-hours');
  });

  it('a post with a date but no time keeps the regular close, and says so', async () => {
    const r = await run([weekCap], '2026-11-11');
    expect(r.postedTime).toBeNull();
    expect(r.claims[0]!.verdict).toBe('contradicted');
    expect(r.claims[0]!.reason).toContain("The post's time isn't known, so this uses the regular close");
  });
});
