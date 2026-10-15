import { describe, expect, it } from 'vitest';
import { EMPTY_CLAIM, SecClient, createSecFigureSource, evaluateFigureClaim } from '../src';
import { createFixtureFetch } from '../src/fixtures';
import type { Claim, FigureEvidence, Metric, ReportedPeriod } from '../src/types';

const sec = new SecClient({ userAgent: 'test test@example.com', fetch: createFixtureFetch() });
const source = createSecFigureSource({ sec });

const claim = (over: Partial<Claim>): Claim => ({
  ...EMPTY_CLAIM,
  id: 'c1',
  quote: '',
  type: 'financial_figure',
  ticker: 'TGSR',
  metric: 'revenue',
  ...over,
});

async function check(over: Partial<Claim>) {
  const c = claim(over);
  const evidence = (await source.fetchEvidence(c)) as FigureEvidence;
  return { ...evaluateFigureClaim(c, evidence), evidence };
}

const M = 1_000_000;

describe('dollar figures: revenue', () => {
  it('holds up when the quarter matches, allowing for rounding', async () => {
    const result = await check({ claimedAmount: 48 * M, fiscalQuarter: 2, fiscalYear: 2026 });
    expect(result.verdict).toBe('holds_up');
    expect(result.reason).toBe('The company reported revenue of $48.2M for the quarter ended Jun 30, 2026 (fiscal Q2 2026).');
    expect(result.citation?.label).toBe('Form 10-Q, filed Aug 6, 2026');
  });

  it('accepts either the latest quarter or the latest year when the post names no period', async () => {
    expect((await check({ claimedAmount: 48.2 * M })).verdict).toBe('holds_up');
    const year = await check({ claimedAmount: 152 * M });
    expect(year.verdict).toBe('holds_up');
    expect(year.reason).toContain('the fiscal year ended Dec 31, 2025');
  });

  it('is misleading when a full-year figure is presented as a quarter', async () => {
    const result = await check({ claimedAmount: 152.4 * M, period: 'quarter' });
    expect(result.verdict).toBe('misleading');
    expect(result.reason).toContain('matches the fiscal year ended Dec 31, 2025, not a single quarter');
  });

  it('looks up the fiscal year the post names and cites that filing', async () => {
    const result = await check({ claimedAmount: 119 * M, fiscalYear: 2024 });
    expect(result.verdict).toBe('holds_up');
    expect(result.reason).toContain('$118.9M for the fiscal year ended Dec 31, 2024');
    expect(result.citation?.url).toBe('https://www.sec.gov/Archives/edgar/data/1999999/000199999926000007/');
  });

  it('works out a fourth quarter from the full year', async () => {
    const result = await check({ claimedAmount: 42 * M, fiscalQuarter: 4, fiscalYear: 2025 });
    expect(result.verdict).toBe('holds_up');
    expect(result.reason).toContain('$42M for the quarter ended Dec 31, 2025 (fiscal Q4 2025)');
    expect(result.reason).toContain('calculated as the full year minus the first three quarters');
  });

  it('is misleading when close, contradicted when far off', async () => {
    const close = await check({ claimedAmount: 53 * M, period: 'quarter' });
    expect(close.verdict).toBe('misleading');
    expect(close.reason).toContain('overstated');

    const far = await check({ claimedAmount: 300 * M, period: 'quarter' });
    expect(far.verdict).toBe('contradicted');
    expect(far.reason).toContain('The post says revenue of $300M.');
  });

  it("says so when the period isn't in the data", async () => {
    const result = await check({ claimedAmount: 10 * M, fiscalQuarter: 3, fiscalYear: 2023 });
    expect(result.verdict).toBe('cant_check');
    expect(result.reason).toContain("doesn't include Q3 2023");
    expect(result.reason).toContain('quarter ended Jun 30, 2026');
  });
});

describe('dollar figures: floors and named quarters', () => {
  it('treats "over $150M" as a floor', async () => {
    expect((await check({ claimedAmount: 150 * M, period: 'year', bound: 'at_least' })).verdict).toBe('holds_up');
    const result = await check({ claimedAmount: 60 * M, period: 'quarter', bound: 'at_least' });
    expect(result.verdict).toBe('contradicted');
    expect(result.reason).toContain('The post says revenue of more than $60M.');
  });

  it('finds "Q1 revenue" with no year in the most recent Q1', async () => {
    const result = await check({ claimedAmount: 44 * M, fiscalQuarter: 1 });
    expect(result.verdict).toBe('holds_up');
    expect(result.reason).toContain('quarter ended Mar 31, 2026');
  });
});

describe('dollar figures: net income', () => {
  it('checks a net loss', async () => {
    const result = await check({ metric: 'net_income', claimedAmount: -6.2 * M, period: 'quarter' });
    expect(result.verdict).toBe('holds_up');
    expect(result.reason).toContain('a net loss of $6.2M');
  });

  it('contradicts a profit claim when the company lost money', async () => {
    const result = await check({ metric: 'net_income', claimedAmount: 6.2 * M, period: 'quarter' });
    expect(result.verdict).toBe('contradicted');
    expect(result.reason).toContain('The post says net income of $6.2M.');
  });

  it('works out a fourth-quarter loss', async () => {
    const result = await check({ metric: 'net_income', claimedAmount: -5.4 * M, fiscalQuarter: 4, fiscalYear: 2025 });
    expect(result.verdict).toBe('holds_up');
  });
});

describe('dollar figures: quarter labels', () => {
  // A company whose fiscal year starts in October: the quarter ended in June
  // is its fiscal Q3, but most readers would call it Q2.
  const period = (over: Partial<ReportedPeriod>): ReportedPeriod => ({
    kind: 'quarter',
    start: '2026-03-29',
    end: '2026-06-27',
    value: 109_400 * M,
    fiscalYear: 2026,
    fiscalQuarter: 3,
    derived: false,
    filing: { accession: '0000000001-26-000001', form: '10-Q', filed: '2026-07-31' },
    ...over,
  });
  const evidence: FigureEvidence = {
    kind: 'financial_figure',
    sourceId: 'sec-figure',
    ticker: 'OFFS',
    entityName: 'Offset Co',
    asOf: '2026-06-27',
    metric: 'revenue' as Exclude<Metric, 'other'>,
    cik: 1,
    quarters: [period({}), period({ start: '2025-12-28', end: '2026-03-28', value: 111_200 * M, fiscalQuarter: 2 })],
    years: [],
    figures: [],
    citation: { label: '', url: '' },
  };

  it('accepts the fiscal label and the calendar label for the same quarter', () => {
    const fiscal = evaluateFigureClaim(claim({ claimedAmount: 109_400 * M, fiscalQuarter: 3, fiscalYear: 2026 }), evidence);
    const calendar = evaluateFigureClaim(claim({ claimedAmount: 109_400 * M, fiscalQuarter: 2, fiscalYear: 2026 }), evidence);
    expect(fiscal.verdict).toBe('holds_up');
    expect(calendar.verdict).toBe('holds_up');
  });

  it('shows both readings when "Q2" is ambiguous and neither matches', () => {
    const result = evaluateFigureClaim(claim({ claimedAmount: 50_000 * M, fiscalQuarter: 2, fiscalYear: 2026 }), evidence);
    expect(result.verdict).toBe('contradicted');
    expect(result.reason).toContain('$109.4B');
    expect(result.reason).toContain('$111.2B');
  });
});
