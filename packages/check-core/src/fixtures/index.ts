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
    if (path.startsWith('/quote')) return { ok: true, status: 200, json: async () => ({ c: 0, d: null, dp: null, pc: 0, t: 0 }) };
    if (path.startsWith('/stock/earnings')) return { ok: true, status: 200, json: async () => [] };
    return { ok: true, status: 200, json: async () => ({}) };
  };
}
