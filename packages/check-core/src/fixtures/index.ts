import type { FetchLike, SecCompanyFacts } from '../sources/sec/client';

// A made-up company in the exact shape the SEC API returns, so the demo and
// the tests run with no network and no keys. Tallgrass Solar is not real.

export const DEMO_CIK = 1999999;

export const DEMO_POST =
  '$TGSR just crushed earnings and nobody is talking about it. Revenue is up 300% this quarter. ' +
  'Short interest is over 40% of the float, so every short has to cover. This is a $40 stock by Friday.';

export const demoTickers = {
  '0': { cik_str: DEMO_CIK, ticker: 'TGSR', title: 'Tallgrass Solar, Inc.' },
};

const q = (start: string, end: string, val: number, accn: string, form: string, filed: string, fy: number, fp: string) => ({
  start,
  end,
  val,
  accn,
  form,
  filed,
  fy,
  fp,
});

// Filings, oldest first. Each 10-Q repeats last year's quarter as a comparison,
// and carries the newer filing's fy/fp, exactly as the real API does.
const K24 = ['0001999999-25-000008', '10-K', '2025-02-27', 2024, 'FY'] as const;
const Q1_25 = ['0001999999-25-000015', '10-Q', '2025-05-08', 2025, 'Q1'] as const;
const Q2_25 = ['0001999999-25-000024', '10-Q', '2025-08-07', 2025, 'Q2'] as const;
const Q3_25 = ['0001999999-25-000033', '10-Q', '2025-11-06', 2025, 'Q3'] as const;
const K25 = ['0001999999-26-000007', '10-K', '2026-02-26', 2025, 'FY'] as const;
const Q1_26 = ['0001999999-26-000016', '10-Q', '2026-05-07', 2026, 'Q1'] as const;
const Q2_26 = ['0001999999-26-000031', '10-Q', '2026-08-06', 2026, 'Q2'] as const;

export const demoCompanyFacts: SecCompanyFacts = {
  cik: DEMO_CIK,
  entityName: 'Tallgrass Solar, Inc.',
  facts: {
    'us-gaap': {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        label: 'Revenue from Contract with Customer, Excluding Assessed Tax',
        units: {
          USD: [
            q('2024-01-01', '2024-12-31', 118_900_000, ...K24),
            q('2025-01-01', '2025-03-31', 34_500_000, ...Q1_25),
            q('2025-04-01', '2025-06-30', 36_800_000, ...Q2_25),
            // Year-to-date figures appear alongside the quarter and must be ignored.
            q('2025-01-01', '2025-06-30', 71_300_000, ...Q2_25),
            q('2025-07-01', '2025-09-30', 39_100_000, ...Q3_25),
            q('2024-01-01', '2024-12-31', 118_900_000, ...K25),
            q('2025-01-01', '2025-12-31', 152_400_000, ...K25),
            q('2025-01-01', '2025-03-31', 34_500_000, ...Q1_26),
            q('2026-01-01', '2026-03-31', 44_000_000, ...Q1_26),
            q('2025-04-01', '2025-06-30', 36_800_000, ...Q2_26),
            q('2026-01-01', '2026-06-30', 92_200_000, ...Q2_26),
            q('2026-04-01', '2026-06-30', 48_200_000, ...Q2_26),
          ],
        },
      },
      OperatingIncomeLoss: {
        label: 'Operating Income (Loss)',
        units: {
          USD: [
            q('2025-04-01', '2025-06-30', -7_900_000, ...Q2_25),
            q('2026-01-01', '2026-03-31', -5_600_000, ...Q1_26),
            q('2025-04-01', '2025-06-30', -7_900_000, ...Q2_26),
            q('2026-04-01', '2026-06-30', -4_100_000, ...Q2_26),
          ],
        },
      },
      NetIncomeLoss: {
        label: 'Net Income (Loss)',
        units: {
          USD: [
            q('2024-01-01', '2024-12-31', -40_200_000, ...K24),
            q('2025-01-01', '2025-03-31', -8_900_000, ...Q1_25),
            q('2025-04-01', '2025-06-30', -9_800_000, ...Q2_25),
            q('2025-07-01', '2025-09-30', -7_400_000, ...Q3_25),
            q('2024-01-01', '2024-12-31', -40_200_000, ...K25),
            q('2025-01-01', '2025-12-31', -31_500_000, ...K25),
            q('2026-01-01', '2026-03-31', -7_100_000, ...Q1_26),
            q('2025-04-01', '2025-06-30', -9_800_000, ...Q2_26),
            q('2026-04-01', '2026-06-30', -6_200_000, ...Q2_26),
          ],
        },
      },
    },
  },
};

/** A stand-in for fetch that serves the demo company and 404s everything else. */
export function createFixtureFetch(): FetchLike {
  const padded = String(DEMO_CIK).padStart(10, '0');
  const routes: Record<string, unknown> = {
    'https://www.sec.gov/files/company_tickers.json': demoTickers,
    [`https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`]: demoCompanyFacts,
  };
  return async (url) => {
    const body = routes[url];
    return body
      ? { ok: true, status: 200, json: async () => body }
      : { ok: false, status: 404, json: async () => ({}) };
  };
}

// Market data for the demo company, in the shape Finnhub returns. Made up.
export const demoFinnhub: Record<string, unknown> = {
  '/quote?symbol=TGSR': { c: 18.42, d: 0.61, dp: 3.42, h: 18.9, l: 17.6, o: 17.8, pc: 17.81, t: 1793721600 },
  '/stock/profile2?symbol=TGSR': { name: 'Tallgrass Solar Inc', ticker: 'TGSR', marketCapitalization: 1290.5, currency: 'USD' },
  '/stock/metric?symbol=TGSR&metric=all': {
    metric: {
      '5DayPriceReturnDaily': 11.8,
      monthToDatePriceReturnDaily: 6.2,
      yearToDatePriceReturnDaily: -14.5,
      '52WeekPriceReturnDaily': -22.1,
      '52WeekHigh': 26.31,
      '52WeekHighDate': '2026-02-11',
      marketCapitalization: 1290.5,
    },
  },
  '/stock/earnings?symbol=TGSR': [
    { actual: -0.09, estimate: -0.11, period: '2026-06-30', quarter: 2, year: 2026, surprise: 0.02, surprisePercent: 18.18, symbol: 'TGSR' },
    { actual: -0.1, estimate: -0.1, period: '2026-03-31', quarter: 1, year: 2026, surprise: 0, surprisePercent: 0, symbol: 'TGSR' },
    { actual: -0.14, estimate: -0.12, period: '2025-12-31', quarter: 4, year: 2025, surprise: -0.02, surprisePercent: -16.67, symbol: 'TGSR' },
    { actual: -0.11, estimate: -0.13, period: '2025-09-30', quarter: 3, year: 2025, surprise: 0.02, surprisePercent: 15.38, symbol: 'TGSR' },
  ],
};

/** A stand-in for fetch that serves Finnhub data for the demo company. Unknown symbols get zeros, as Finnhub does. */
export function createFinnhubFixtureFetch(): FetchLike {
  return async (url) => {
    const path = url.replace('https://finnhub.io/api/v1', '');
    const body = demoFinnhub[path];
    if (body) return { ok: true, status: 200, json: async () => body };
    if (path.startsWith('/calendar/earnings') && path.includes('symbol=TGSR')) {
      return { ok: true, status: 200, json: async () => ({ earningsCalendar: [{ date: '2026-11-12', hour: 'amc', quarter: 3, year: 2026, symbol: 'TGSR' }] }) };
    }
    if (path.startsWith('/quote')) return { ok: true, status: 200, json: async () => ({ c: 0, d: null, dp: null, pc: 0, t: 0 }) };
    if (path.startsWith('/stock/earnings')) return { ok: true, status: 200, json: async () => [] };
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

// Price history for the demo company, in the shape Alpaca returns. Made up, but
// it agrees with the Finnhub fixture: $18.42 on Nov 3, 2026, a 52-week high of
// $26.31 on Feb 11, 2026, and $16.48 a week before Nov 3.
const DEMO_ANCHORS: Array<[string, number]> = [
  ['2023-04-14', 9.8], // first trading day: the demo company is newer than the history
  ['2024-06-03', 15.2],
  ['2025-11-03', 23.6],
  ['2026-02-11', 26.0],
  ['2026-06-01', 21.4],
  ['2026-10-27', 16.48],
  ['2026-10-30', 17.2],
  ['2026-11-02', 17.81],
  ['2026-11-03', 18.42],
];

/** Weekday closes between the anchors, with a small deterministic wiggle. */
export function demoDailyBars(): Array<{ t: string; o: number; h: number; l: number; c: number; v: number }> {
  const out: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }> = [];
  const day = 86_400_000;
  const round = (n: number) => Math.round(n * 100) / 100;
  let prev = DEMO_ANCHORS[0]![1];
  for (let a = 0; a < DEMO_ANCHORS.length - 1; a++) {
    const [fromDate, fromPrice] = DEMO_ANCHORS[a]!;
    const [toDate, toPrice] = DEMO_ANCHORS[a + 1]!;
    const from = Date.parse(`${fromDate}T00:00:00Z`);
    const to = Date.parse(`${toDate}T00:00:00Z`);
    for (let t = from; t < to || (a === DEMO_ANCHORS.length - 2 && t === to); t += day) {
      const weekday = new Date(t).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      const share = (t - from) / (to - from || 1);
      const date = new Date(t).toISOString().slice(0, 10);
      const anchor = DEMO_ANCHORS.find(([d]) => d === date);
      const c = anchor ? anchor[1] : round(fromPrice + (toPrice - fromPrice) * share + Math.sin(t / day / 3) * 0.25);
      const o = round(prev);
      // Feb 11, 2026 sets the 52-week high of $26.31.
      const h = date === '2026-02-11' ? 26.31 : round(Math.min(Math.max(o, c) * 1.012, 26.2));
      const l = round(Math.min(o, c) * 0.988);
      // Alpaca stamps a daily bar at midnight New York.
      out.push({ t: `${date}T05:00:00Z`, o, h, l, c, v: 1_000_000 });
      prev = c;
    }
  }
  return out;
}

/** Nov 3, 2026: pre-market trades up to $18.90; Nov 2: after-hours trades down to $17.30. */
const DEMO_INTRADAY: Record<string, Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>> = {
  '2026-11-03': [
    { t: '2026-11-03T12:00:00Z', o: 17.9, h: 18.1, l: 17.85, c: 18.05, v: 2000 }, // 7:00 AM ET
    { t: '2026-11-03T14:25:00Z', o: 18.6, h: 18.9, l: 18.55, c: 18.88, v: 4000 }, // 9:25 AM ET
    { t: '2026-11-03T14:30:00Z', o: 18.88, h: 18.95, l: 18.3, c: 18.4, v: 90000 }, // the open
  ],
  '2026-11-02': [
    { t: '2026-11-02T20:55:00Z', o: 17.7, h: 17.85, l: 17.7, c: 17.81, v: 90000 }, // 3:55 PM ET
    { t: '2026-11-02T22:30:00Z', o: 17.6, h: 17.62, l: 17.25, c: 17.3, v: 3000 }, // 5:30 PM ET
  ],
};

/** A stand-in for fetch that serves Alpaca bars for the demo company. Other symbols get no bars. */
export function createAlpacaFixtureFetch(): FetchLike {
  const daily = demoDailyBars();
  return async (url) => {
    const u = new URL(url);
    const symbol = decodeURIComponent(u.pathname.split('/')[3] ?? '');
    const timeframe = u.searchParams.get('timeframe');
    const start = u.searchParams.get('start') ?? '';
    const end = u.searchParams.get('end') ?? '9999';
    if (symbol !== 'TGSR') return { ok: true, status: 200, json: async () => ({ bars: [], symbol, next_page_token: null }) };
    const bars = timeframe === '1Day' ? daily.filter((b) => b.t >= start && b.t <= end) : (DEMO_INTRADAY[start.slice(0, 10)] ?? []).filter((b) => b.t <= end);
    return { ok: true, status: 200, json: async () => ({ bars, symbol, next_page_token: null }) };
  };
}
