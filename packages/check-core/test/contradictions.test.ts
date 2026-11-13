// False "Contradicted" verdicts found by replaying 94 saved posts. Each test is
// one real post's claim: a mismatch built on a guess must come back "can't be
// checked", and a claim that is true under another reading must hold up.
import { describe, expect, it } from 'vitest';
import { EMPTY_CLAIM, checkPost, evaluateEarningsClaim, evaluateFigureClaim, normalizeClaims, postDateInText } from '../src';
import { evaluateCalendarClaim } from '../src/sources/finnhub/calendarSource';
import { evaluateRevenueClaim } from '../src/sources/sec/revenueSource';
import type { CalendarEvidence, Claim, EarningsEvidence, ExtractedClaim, FigureEvidence, ReportedPeriod, RevenueEvidence } from '../src/types';

const NOW = new Date('2026-11-12T15:00:00Z');
const B = 1e9;
const M = 1e6;

const ex = (o: Partial<ExtractedClaim>): ExtractedClaim => ({ ...EMPTY_CLAIM, quote: 'q', type: 'other', ...o });
const claim = (o: Partial<Claim>): Claim => ({ ...EMPTY_CLAIM, id: 'c1', quote: 'q', type: 'revenue_growth', ticker: 'NVDA', direction: 'up', ...o });

// A source that says "contradicted" to everything, to see what the pipeline does with it.
const contradicts = {
  id: 'always-wrong',
  ttlMs: 0,
  supports: () => true,
  cacheKey: (c: Claim) => `${c.ticker}:${c.quote}`,
  fetchEvidence: async (c: Claim) => ({ kind: 'market', ticker: c.ticker }) as any,
  evaluate: () => ({ verdict: 'contradicted' as const, reason: 'Stock is down 2.1% today. Prices move all day, so the post may have been right when it was written.' }),
};
const run = (text: string, claims: ExtractedClaim[], postedAt?: string) =>
  checkPost(text, { extractor: { name: 'stub', extractClaims: async () => claims }, sources: [contradicts as any], now: () => NOW }, { postedAt });

// Fiscal year ends in late January, like NVIDIA's.
const q = (end: string, fiscalYear: number | null, fiscalQuarter: 1 | 2 | 3 | 4 | null, value: number): ReportedPeriod => ({
  kind: 'quarter',
  start: new Date(Date.parse(`${end}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10),
  end,
  value,
  fiscalYear,
  fiscalQuarter,
  derived: false,
  filing: { accession: '0000000000-00-000000', form: '10-Q', filed: end },
});
const nvdaQuarters = [
  q('2025-04-27', 2026, 1, 44.1 * B),
  q('2025-01-26', 2025, 4, 39.3 * B),
  q('2024-10-27', 2025, 3, 35.1 * B),
  q('2024-07-28', 2025, 2, 30.0 * B),
  q('2024-04-28', 2025, 1, 26.0 * B),
  q('2024-01-28', 2024, 4, 22.1 * B),
  q('2023-10-29', 2024, 3, 18.1 * B),
  q('2023-07-30', 2024, 2, 13.5 * B),
  q('2023-04-30', 2024, 1, 7.19 * B),
];
const revenue: RevenueEvidence = {
  kind: 'revenue_growth',
  sourceId: 'sec-revenue',
  ticker: 'NVDA',
  entityName: 'NVIDIA',
  asOf: '2025-04-27',
  bases: [],
  quarters: nvdaQuarters,
  years: [],
  figures: [],
  citation: { label: '', url: '' },
};

describe('post dates and sessions', () => {
  it('reads the age in a copied Reddit header', () => {
    expect(postDateInText('r/investing\n•\n2d ago\nu/TalVal_Research\nEvery big chip stock rose on Monday', NOW)).toBe('2026-11-10');
  });

  it('treats a Reddit "13d ago" date as approximate for one-day moves', async () => {
    const text = 'r/StocksAndTrading\n•\n13d ago\nu/someone\nGoogle fell about 13% today.';
    const r = await run(text, [ex({ quote: 'Google fell about 13%', type: 'price_move', ticker: 'GOOGL', claimedPercent: 13, direction: 'down', window: 'day' })]);
    expect(r.claims[0]!.claim.postedAt).toBe('2026-10-30');
    expect(r.claims[0]!.verdict).toBe('cant_check');
    expect(r.claims[0]!.reason).toContain("Reddit's rounded age");
  });

  it('checks "Monday\'s closes" on that Monday, not on the post date', async () => {
    const r = await run("Monday's closes:\n- AMD +13%", [ex({ quote: 'AMD +13%', type: 'price_move', ticker: 'AMD', claimedPercent: 13, direction: 'up', window: 'day' })], '2026-11-11');
    expect(r.claims[0]!.claim.postedAt).toBe('2026-11-09');
  });

  it('measures "in one month" over a rolling month, not month to date', async () => {
    const text = 'In one month, healthcare stocks rose 11%.\n- Health care (XLV) +11.4%\nAnyone moved money into healthcare this month?';
    const r = await run(text, [ex({ quote: 'Health care (XLV) +11.4%', type: 'price_move', ticker: 'XLV', claimedPercent: 11.4, direction: 'up', window: 'month' })], '2026-11-12');
    expect(r.claims[0]!.claim).toMatchObject({ window: null, windowDays: 30 });
  });

  it('does not call an undated "today" move wrong: it may be from another day', async () => {
    const r = await run('AMD +13%', [ex({ quote: 'AMD +13%', type: 'price_move', ticker: 'AMD', claimedPercent: 13, direction: 'up', window: 'day' })]);
    expect(r.claims[0]!.verdict).toBe('cant_check');
    expect(r.claims[0]!.reason).toContain("add the post's date");
    expect(r.claims[0]!.reason).not.toContain('Prices move all day');
  });

  it('reads "the S&P" as the index, not S&P Global', async () => {
    const r = await run('The S&P was down 0.3%', [ex({ quote: 'The S&P was down 0.3%', type: 'price_move', ticker: 'SPGI', company: 'S&P Global', claimedPercent: 0.3, direction: 'down', window: 'day' })]);
    expect(r.claims[0]!.claim.ticker).toBe('SPY');
  });

  it('sets aside investment values and past calendar years', async () => {
    const text = 'An investment made ten years ago would be worth $1 million today:\n1. Nvidia ($NVDA): $7,800\nSPY 2022 → -27.92%';
    const r = await run(text, [
      ex({ quote: 'Nvidia ($NVDA): $7,800', type: 'price_move', ticker: 'NVDA', claimedAmount: 7800 }),
      ex({ quote: '2022 → -27.92%', type: 'price_move', ticker: 'SPY', claimedPercent: 27.92, direction: 'down', window: 'year' }),
    ]);
    expect(r.claims.map((c) => c.verdict)).toEqual(['cant_check', 'cant_check']);
    expect(r.claims[0]!.reason).toContain('what an investment would be worth');
    expect(r.claims[1]!.reason).toContain('the move in 2022');
  });
});

describe('what the claim is about', () => {
  it('keeps other measures out of the revenue check', () => {
    const [income, prices, rev] = normalizeClaims([
      { quote: 'Net Income = $35.8 billion (up 31% YoY)', type: 'revenue_growth', claimedPercent: 31, direction: 'up' },
      { quote: 'ad prices +14%', type: 'revenue_growth', claimedPercent: 14, direction: 'up' },
      { quote: 'Revenue = $90 billion (up 18% YoY)', type: 'revenue_growth', claimedPercent: 18, direction: 'up' },
    ]);
    expect([income!.type, prices!.type, rev!.type]).toEqual(['other', 'other', 'revenue_growth']);
  });

  it('reads "growth slowed to 23%" as revenue still growing', () => {
    const [c] = normalizeClaims([{ quote: 'its quarterly revenue growth slowed from 51% to 23%', type: 'revenue_growth', claimedPercent: 23, direction: 'down' }]);
    expect(c!.direction).toBe('up');
  });

  it('reads "its $46.75 high" as no particular high, not the all-time one', () => {
    const [c] = normalizeClaims([{ quote: '~72% under its $46.75 high', type: 'price_move', claimedPercent: 72, direction: 'down', reference: 'high_all_time' }]);
    expect(c!.reference).toBe('high');
  });
});

describe('which quarter', () => {
  it('checks "fiscal Q1 2025" against the fiscal quarter, not calendar Q1 2025', () => {
    const r = evaluateRevenueClaim(claim({ quote: 'NVIDIA revenue increased 262% year over year in fiscal Q1 2025', claimedPercent: 262, fiscalQuarter: 1, fiscalYear: 2025, period: 'quarter', comparison: 'yoy' }), revenue);
    expect(r.verdict).toBe('holds_up');
    expect(r.reason).toContain('Apr 28, 2024');
  });

  it('accepts whichever reading of "Q1 2025" fits when the post does not say fiscal', () => {
    const r = evaluateRevenueClaim(claim({ quote: 'revenue up 262% in Q1 2025', claimedPercent: 262, fiscalQuarter: 1, fiscalYear: 2025, period: 'quarter', comparison: 'yoy' }), revenue);
    expect(r.verdict).toBe('holds_up');
  });

  it('does not call an undated figure wrong when it matches an earlier quarter', () => {
    const r = evaluateRevenueClaim(claim({ quote: 'up 262% from a year earlier', claimedPercent: 262 }), revenue);
    expect(r.verdict).toBe('cant_check');
    expect(r.reason).toContain('The post has no date');
  });

  it('sets aside trailing-twelve-month growth', () => {
    const r = evaluateRevenueClaim(claim({ quote: 'grew revenue 115% in 12 months', claimedPercent: 115 }), revenue);
    expect(r.verdict).toBe('cant_check');
  });

  it('reads "Q2" as the quarter about to be filed, not last year\'s Q2', () => {
    const r = evaluateRevenueClaim(claim({ quote: 'strong Q2 results yesterday, revenue +50% YoY', claimedPercent: 50, fiscalQuarter: 2, period: 'quarter', comparison: 'yoy' }), revenue);
    expect(r.verdict).toBe('cant_check');
    expect(r.reason).toContain("Q2 2026 isn't filed yet");
  });

  it('labels a quarter read from an earnings release (PENG "Q4 ... $567M")', () => {
    const quarters = [q('2026-08-28', null, null, 567 * M), q('2026-05-29', 2026, 3, 479 * M), q('2026-02-27', 2026, 2, 343 * M), q('2025-11-28', 2026, 1, 343 * M)];
    const evidence: FigureEvidence = { kind: 'financial_figure', sourceId: 'sec-figure', ticker: 'PENG', entityName: 'Penguin', asOf: '2026-08-28', metric: 'revenue', quarters, years: [], figures: [], citation: { label: '', url: '' } } as any;
    const r = evaluateFigureClaim(claim({ type: 'financial_figure', metric: 'revenue', quote: 'Q4 revenue surged 68% YoY to a record $567M', claimedAmount: 567 * M, fiscalQuarter: 4, period: 'quarter' }), evidence);
    expect(r.verdict).toBe('holds_up');
  });

  it('sets aside adjusted (non-GAAP) dollar figures', () => {
    const evidence = { kind: 'financial_figure', ticker: 'AMAT', metric: 'operating_income', quarters: nvdaQuarters, years: [] } as any;
    const r = evaluateFigureClaim(claim({ type: 'financial_figure', metric: 'operating_income', quote: 'Non-GAAP Oper Income: $3.68B', claimedAmount: 3.68 * B }), evidence);
    expect(r.verdict).toBe('cant_check');
  });
});

describe('earnings and estimates', () => {
  const earnings: EarningsEvidence = {
    kind: 'earnings_result',
    sourceId: 'finnhub-earnings',
    ticker: 'MSFT',
    entityName: 'MSFT',
    asOf: '2026-06-30',
    quarters: [
      { period: '2026-06-30', fiscalYear: 2026, fiscalQuarter: 4, actual: 4.81, estimate: 4.6, surprisePercent: 4.6 },
      { period: '2026-03-31', fiscalYear: 2026, fiscalQuarter: 3, actual: 4.3, estimate: 4.2, surprisePercent: 2.4 },
      { period: '2025-12-31', fiscalYear: 2026, fiscalQuarter: 2, actual: 4.14, estimate: 4.03, surprisePercent: 2.7 },
    ],
    figures: [],
    citation: { label: '', url: '' },
  };

  it('accepts "Q2 2026" EPS as the calendar quarter (Apr - Jun) when that is the one that fits', () => {
    const r = evaluateEarningsClaim(claim({ type: 'earnings_result', metric: 'eps', quote: 'Earnings Per Share = $4.81', claimedAmount: 4.81, fiscalQuarter: 2, fiscalYear: 2026 }), earnings);
    expect(r.verdict).toBe('holds_up');
  });

  it('does not call a GAAP "miss" wrong because the adjusted figure beat', () => {
    const r = evaluateEarningsClaim(claim({ type: 'earnings_result', metric: 'eps', quote: 'The Q3 EPS "miss" was a one-time $9.89B legal settlement', vsEstimate: 'miss', fiscalQuarter: 3, fiscalYear: 2026 }), earnings);
    expect(r.verdict).toBe('cant_check');
    expect(r.reason).toContain('GAAP');
  });

  const calendar: CalendarEvidence = {
    kind: 'earnings_calendar',
    sourceId: 'finnhub-calendar',
    ticker: 'AVGO',
    entityName: 'AVGO',
    asOf: '2026-11-12',
    reports: [{ date: '2026-12-09', hour: 'amc', fiscalYear: 2026, fiscalQuarter: 4, epsEstimate: 1.9, revenueEstimate: 35.6 * B, epsActual: null, revenueActual: null }],
    figures: [],
    citation: { label: '', url: '' },
  };
  const consensus = (o: Partial<Claim>) => evaluateCalendarClaim(claim({ type: 'consensus_estimate', ticker: 'AVGO', postedAt: '2026-11-12', ...o }), calendar, '2026-11-12');

  it('keeps guidance, full-year figures and gaps out of the consensus check', () => {
    expect(consensus({ quote: 'management forecasting $21.7B in Q4', metric: 'revenue', claimedAmount: 21.7 * B }).verdict).toBe('cant_check');
    expect(consensus({ quote: 'FY27E clean EPS $33.00 (consensus ~$34.38)', metric: 'eps', claimedAmount: 34.38 }).verdict).toBe('cant_check');
    expect(consensus({ quote: 'Q4 revenue guidance came in roughly $1.1 billion below investor expectations', metric: 'revenue', claimedAmount: 1.1 * B }).verdict).toBe('cant_check');
    // A plain consensus figure is still checked.
    expect(consensus({ quote: 'Street expects $35.6B in revenue', metric: 'revenue', claimedAmount: 35.6 * B }).verdict).toBe('holds_up');
  });
});
