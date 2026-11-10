import { describe, expect, it, vi } from 'vitest';
import { FinnhubClient, SecClient, createTickerSnapshots, describeFiling, type FetchLike } from '../src';
import { DEMO_CIK, createFinnhubFixtureFetch, demoTickers } from '../src/fixtures';

const PADDED = String(DEMO_CIK).padStart(10, '0');

function sec(extra: Record<string, unknown> = {}): SecClient {
  const routes: Record<string, unknown> = {
    'https://www.sec.gov/files/company_tickers.json': demoTickers,
    [`https://data.sec.gov/submissions/CIK${PADDED}.json`]: {
      filings: {
        recent: {
          accessionNumber: ['a-5', 'a-4', 'a-3', 'a-2', 'a-1'],
          filingDate: ['2026-11-02', '2026-10-29', '2026-10-20', '2026-10-01', '2026-08-06'],
          form: ['4', '8-K', '8-K', '10-Q/A', '10-Q'],
          items: ['', '2.02,9.01', '5.02', '', ''],
          primaryDocument: ['f4.xml', 'tgsr-8k.htm', 'tgsr-8k2.htm', 'tgsr-10qa.htm', 'tgsr-10q.htm'],
        },
      },
    },
    ...extra,
  };
  const fetch: FetchLike = async (url) => {
    const body = routes[url];
    return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
  };
  return new SecClient({ userAgent: 'test test@example.com', fetch });
}

const now = () => new Date('2026-11-03T14:00:00Z');

describe('filing labels', () => {
  it('names filings in plain words', () => {
    expect(describeFiling('8-K', '2.02,9.01')).toBe('Earnings release');
    expect(describeFiling('8-K', '9.01,5.02')).toBe('Leadership change');
    expect(describeFiling('8-K', '9.01')).toBe('Current report');
    expect(describeFiling('10-Q/A', '')).toBe('Quarterly report (amended)');
    expect(describeFiling('10-K', '')).toBe('Annual report');
  });
});

describe('ticker snapshots', () => {
  it('builds the daily card from market data, earnings and filings', async () => {
    const finnhub = new FinnhubClient({ apiKey: 't', fetch: createFinnhubFixtureFetch() });
    const [card] = await createTickerSnapshots({ sec: sec(), finnhub, now }).get(['TGSR']);
    expect(card).toMatchObject({
      ticker: 'TGSR',
      name: 'Tallgrass Solar Inc',
      price: 18.42,
      dayChangePercent: 3.42,
      marketCap: 1.2905e9,
      nextEarnings: { date: '2026-11-12', timing: 'after_close' },
      lastEarnings: { label: 'Fiscal Q2 2026', actual: -0.09, estimate: -0.11, outcome: 'beat' },
      unavailable: [],
    });
    // Insider forms (4) are left out; the window is 45 days, so the August 10-Q is too.
    expect(card!.filings.map((f) => [f.label, f.form, f.filed])).toEqual([
      ['Earnings release', '8-K', '2026-10-29'],
      ['Leadership change', '8-K', '2026-10-20'],
      ['Quarterly report (amended)', '10-Q/A', '2026-10-01'],
    ]);
    expect(card!.filings[0]!.url).toBe(`https://www.sec.gov/Archives/edgar/data/${DEMO_CIK}/a4/tgsr-8k.htm`);
  });

  it('keeps the rest of the card when one source fails', async () => {
    const down: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const finnhub = new FinnhubClient({ apiKey: 't', fetch: down });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [card] = await createTickerSnapshots({ sec: sec(), finnhub, now }).get(['TGSR']);
    quiet.mockRestore();
    expect(card!.price).toBeNull();
    expect(card!.unavailable).toEqual(expect.arrayContaining(['market', 'earnings']));
    expect(card!.filings).toHaveLength(3);
    expect(card!.name).toBe('Tallgrass Solar, Inc.');
  });

  it('works without Finnhub (filings only)', async () => {
    const [card] = await createTickerSnapshots({ sec: sec(), finnhub: null, now }).get(['TGSR']);
    expect(card).toMatchObject({ price: null, nextEarnings: null, unavailable: [] });
    expect(card!.filings).toHaveLength(3);
  });

  it('caches each ticker for ten minutes', async () => {
    const fetch = vi.fn(createFinnhubFixtureFetch());
    const cards = createTickerSnapshots({ sec: sec(), finnhub: new FinnhubClient({ apiKey: 't', fetch }), now });
    await cards.get(['TGSR']);
    await cards.get(['TGSR', 'TGSR']);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
