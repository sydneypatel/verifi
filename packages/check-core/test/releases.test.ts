import { describe, expect, it, vi } from 'vitest';
import { MemoryCache, SecClient, checkPost, createEarningsReleases, createRuleBasedExtractor, createSecFigureSource, createSecRevenueSource, htmlToText, pickExhibit, verifyReading, type FetchLike, type ReleaseReader, type ReleaseReading } from '../src';
import { DEMO_CIK, demoCompanyFacts, demoTickers } from '../src/fixtures';
import { numbersIn, parseLongDate, printedIn } from '../src/sources/sec/releases';

// A made-up Q3 2026 release for the demo company, filed before its 10-Q.
const RELEASE_HTML = `<html><head><title>x</title><style>p{}</style></head><body>
<p>Tallgrass Solar Reports Third Quarter 2026 Results</p>
<p>Revenue grew 33% year over year&#8212;a record.</p>
<table>
<tr><td></td><td>Three Months Ended</td></tr>
<tr><td></td><td>September&nbsp;30, 2026</td><td>September 30, 2025</td></tr>
<tr><td>(in thousands, except per share)</td></tr>
<tr><td>Total revenue</td><td>$</td><td>52,100</td><td>$</td><td>39,100</td></tr>
<tr><td>Net loss</td><td>$</td><td>(5,300</td><td>)</td><td>$</td><td>(7,400</td><td>)</td></tr>
<tr><td>Net loss per share, diluted</td><td>$</td><td>(0.08</td><td>)</td><td>$</td><td>(0.11</td><td>)</td></tr>
</table></body></html>`;

const TEXT = htmlToText(RELEASE_HTML);

const GOOD: ReleaseReading = {
  periodEndText: 'September 30, 2026',
  fiscalYear: 2026,
  fiscalQuarter: 3,
  revenue: { current: 52_100_000, prior: 39_100_000, quote: 'Total revenue $ 52,100 $ 39,100' },
  netIncome: { current: -5_300_000, prior: -7_400_000, quote: 'Net loss $ (5,300 ) $ (7,400 )' },
  eps: { current: -0.08, prior: -0.11, quote: 'Net loss per share, diluted $ (0.08 ) $ (0.11 )' },
};

describe('reading a press release', () => {
  it('turns HTML tables into one row per line', () => {
    expect(TEXT).toContain('Total revenue $ 52,100 $ 39,100');
    expect(TEXT).toContain('September 30, 2026');
    expect(TEXT).toContain('—a record');
    expect(TEXT).not.toContain('p{}');
  });

  it('reads signed numbers and table scales', () => {
    expect(numbersIn('Net loss $ (5,300 ) $ (7,400 )')).toEqual([-5300, -7400]);
    expect(printedIn(52_100_000, 'Total revenue $ 52,100', false)).toBe(true);
    expect(printedIn(52_900_000, 'Total revenue $ 52,100', false)).toBe(false);
    expect(printedIn(-0.08, '$ (0.08 )', true)).toBe(true);
    expect(parseLongDate('Sept. 30, 2026')).toBe('2026-09-30');
  });

  it('keeps figures that are printed in the release', () => {
    expect(verifyReading(TEXT, GOOD)).toEqual({
      periodEnd: '2026-09-30',
      fiscalYear: 2026,
      fiscalQuarter: 3,
      revenue: { current: 52_100_000, prior: 39_100_000 },
      netIncome: { current: -5_300_000, prior: -7_400_000 },
      eps: { current: -0.08, prior: -0.11 },
    });
  });

  it('drops a figure the release does not print, even with a real quote', () => {
    const misread = { ...GOOD, revenue: { current: 521_000_000, prior: 39_100_000, quote: 'Total revenue $ 52,100 $ 39,100' } };
    expect(verifyReading(TEXT, misread)?.revenue).toBeNull();
  });

  it('drops a figure whose quote is not in the release', () => {
    const invented = { ...GOOD, revenue: { current: 60_000_000, prior: null, quote: 'Total revenue $ 60,000' } };
    expect(verifyReading(TEXT, invented)?.revenue).toBeNull();
  });

  it('rejects the whole reading when the period date is not printed', () => {
    expect(verifyReading(TEXT, { ...GOOD, periodEndText: 'June 30, 2026' })).toBeNull();
  });

  it('finds Exhibit 99.1 among a filing’s files', () => {
    const files = ['0001-index.htm', 'tgsr-20261029.htm', 'tgsr-ex99_2.htm', 'tgsr-ex99_1.htm', 'logo.jpg'].map((name) => ({ name }));
    expect(pickExhibit(files)).toBe('tgsr-ex99_1.htm');
    expect(pickExhibit([{ name: 'a8-kex991q3fy26.htm' }])).toBe('a8-kex991q3fy26.htm');
    expect(pickExhibit([{ name: 'tgsr-8k.htm' }])).toBeNull();
  });
});

// The demo company's SEC data, plus a submissions list with a Q3 release filed after its last 10-Q (Aug 6).
const PADDED = String(DEMO_CIK).padStart(10, '0');
const ACCESSION = '0001999999-26-000040';
const FOLDER = `https://www.sec.gov/Archives/edgar/data/${DEMO_CIK}/000199999926000040/`;

function secFetch(releaseFiled = '2026-10-29'): FetchLike {
  const json: Record<string, unknown> = {
    'https://www.sec.gov/files/company_tickers.json': demoTickers,
    [`https://data.sec.gov/api/xbrl/companyfacts/CIK${PADDED}.json`]: demoCompanyFacts,
    [`https://data.sec.gov/submissions/CIK${PADDED}.json`]: {
      filings: {
        recent: {
          accessionNumber: ['0001999999-26-000041', ACCESSION, '0001999999-26-000031'],
          filingDate: ['2026-10-30', releaseFiled, '2026-08-06'],
          form: ['4', '8-K', '10-Q'],
          items: ['', '2.02,9.01', ''],
        },
      },
    },
    [`${FOLDER}index.json`]: { directory: { item: [{ name: 'tgsr-8k.htm' }, { name: 'tgsr-ex99_1.htm' }] } },
  };
  return async (url) => {
    if (url === `${FOLDER}tgsr-ex99_1.htm`) return { ok: true, status: 200, json: async () => ({}), text: async () => RELEASE_HTML };
    const body = json[url];
    return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
  };
}

function setup(reading: ReleaseReading | null = GOOD, releaseFiled?: string) {
  const sec = new SecClient({ userAgent: 'test test@example.com', fetch: secFetch(releaseFiled) });
  const read = vi.fn(async () => reading);
  const reader: ReleaseReader = { name: 'stub', read };
  const releases = createEarningsReleases({ sec, reader });
  const deps = {
    extractor: createRuleBasedExtractor(),
    sources: [createSecRevenueSource({ sec, releases }), createSecFigureSource({ sec, releases })],
    cache: new MemoryCache(),
  };
  return { deps, read };
}

describe('earnings releases in the pipeline', () => {
  it('checks the newest quarter from the release before the 10-Q is filed', async () => {
    const { deps, read } = setup();
    const result = await checkPost('$TGSR Q3 revenue of $52.1M. $TGSR revenue is up 33% this quarter. A $5.3M net loss.', deps);

    expect(result.claims.map((c) => [c.claim.type, c.verdict])).toEqual([
      ['financial_figure', 'holds_up'],
      ['revenue_growth', 'holds_up'],
      ['financial_figure', 'holds_up'],
    ]);
    const first = result.claims[0]!;
    expect(first.reason).toContain('the quarter ended Sep 30, 2026');
    expect(first.evidence?.citation).toEqual({ label: 'Form 8-K earnings release, filed Oct 29, 2026', url: `${FOLDER}tgsr-ex99_1.htm` });
    // Revenue growth: release quarter vs the filed quarter a year earlier ($39.1M).
    expect(result.claims[1]!.reason).toContain('$39.1M to $52.1M');
    // One release, read once, shared by all three claims.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('falls back to the filings when the release cannot be verified', async () => {
    const { deps } = setup({ ...GOOD, periodEndText: 'June 30, 2026' });
    const result = await checkPost('$TGSR revenue of $52.1M this quarter.', deps);
    // Checked against the 10-Q's quarter ($48.2M), not the unverified release.
    expect(result.claims[0]!.verdict).toBe('misleading');
    expect(result.claims[0]!.evidence?.citation.label).toBe('Form 10-Q, filed Aug 6, 2026');
  });

  it('skips the release when the 10-Q already covers it', async () => {
    const { deps, read } = setup(GOOD, '2026-08-01');
    await checkPost('$TGSR revenue of $48.2M this quarter.', deps);
    expect(read).not.toHaveBeenCalled();
  });

  it('never fails a check when the reader throws', async () => {
    const sec = new SecClient({ userAgent: 'test test@example.com', fetch: secFetch() });
    const reader: ReleaseReader = { name: 'broken', read: async () => { throw new Error('model down'); } };
    const releases = createEarningsReleases({ sec, reader });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await checkPost('$TGSR revenue of $48.2M this quarter.', {
      extractor: createRuleBasedExtractor(),
      sources: [createSecFigureSource({ sec, releases })],
    });
    quiet.mockRestore();
    expect(result.claims[0]!.verdict).toBe('holds_up');
  });
});
