import { describe, expect, it } from 'vitest';
import { demoCompanyFacts } from '../src/fixtures';
import { summarizeRevenue } from '../src/sources/sec/revenueFacts';
import { evaluateRevenueClaim } from '../src/sources/sec/revenueSource';
import { EMPTY_CLAIM } from '../src/llm/types';
import type { Claim, RevenueEvidence } from '../src/types';

const summary = summarizeRevenue(demoCompanyFacts)!;

const evidence: RevenueEvidence = {
  kind: 'revenue_growth',
  sourceId: 'sec-revenue',
  ticker: 'TGSR',
  entityName: 'Tallgrass Solar, Inc.',
  asOf: summary.latest.periodEnd,
  bases: summary.bases,
  figures: [],
  citation: { label: '', url: '' },
};

const claim = (over: Partial<Claim>): Claim => ({
  ...EMPTY_CLAIM,
  id: 'c1',
  quote: '',
  type: 'revenue_growth',
  ticker: 'TGSR',
  direction: 'up',
  ...over,
});

describe('summarizeRevenue', () => {
  it('computes year-over-year growth for the latest quarter', () => {
    const yoy = summary.bases.find((b) => b.id === 'quarter_yoy')!;
    expect(yoy.current.value).toBe(48_200_000);
    expect(yoy.prior.value).toBe(36_800_000);
    expect(yoy.percent).toBeCloseTo(30.98, 1);
  });

  it('computes quarter-over-quarter and full-year growth', () => {
    expect(summary.bases.find((b) => b.id === 'quarter_qoq')!.percent).toBeCloseTo(9.55, 1);
    expect(summary.bases.find((b) => b.id === 'year_yoy')!.percent).toBeCloseTo(28.17, 1);
  });

  it('ignores year-to-date periods and points at the newest filing', () => {
    expect(summary.bases.every((b) => b.current.value !== 92_200_000)).toBe(true);
    expect(summary.latest).toMatchObject({ form: '10-Q', filed: '2026-08-06', periodEnd: '2026-06-30' });
  });

  it('returns null when the company reports no revenue', () => {
    expect(summarizeRevenue({ cik: 1, entityName: 'X', facts: {} })).toBeNull();
  });
});

describe('evaluateRevenueClaim', () => {
  it('holds up when the figure matches the filing', () => {
    expect(evaluateRevenueClaim(claim({ claimedPercent: 31 }), evidence).verdict).toBe('holds_up');
  });

  it('is contradicted when the figure is far off', () => {
    const result = evaluateRevenueClaim(claim({ claimedPercent: 300 }), evidence);
    expect(result.verdict).toBe('contradicted');
    expect(result.reason).toContain('up 31.0%');
    expect(result.reason).toContain('$36.8M to $48.2M');
  });

  it('is misleading when the figure is true of a different comparison', () => {
    const result = evaluateRevenueClaim(claim({ claimedPercent: 10 }), evidence);
    expect(result.verdict).toBe('misleading');
    expect(result.reason).toContain('quarter before');
  });

  it('is misleading when close but overstated', () => {
    const result = evaluateRevenueClaim(claim({ claimedPercent: 37 }), evidence);
    expect(result.verdict).toBe('misleading');
    expect(result.reason).toContain('overstated');
  });

  it('is contradicted when the direction is wrong', () => {
    expect(evaluateRevenueClaim(claim({ claimedPercent: 31, direction: 'down' }), evidence).verdict).toBe('contradicted');
  });

  it('checks direction alone when the post gives no number', () => {
    expect(evaluateRevenueClaim(claim({}), evidence).verdict).toBe('holds_up');
    expect(evaluateRevenueClaim(claim({ direction: 'down' }), evidence).verdict).toBe('contradicted');
  });

  it('treats "more than" as a floor', () => {
    expect(evaluateRevenueClaim(claim({ claimedPercent: 25, bound: 'at_least' }), evidence).verdict).toBe('holds_up');
    const doubled = evaluateRevenueClaim(claim({ claimedPercent: 100, bound: 'at_least' }), evidence);
    expect(doubled.verdict).toBe('contradicted');
    expect(doubled.reason).toContain('The post says more than 100%.');
    expect(evaluateRevenueClaim(claim({ claimedPercent: 40, bound: 'at_most' }), evidence).verdict).toBe('holds_up');
  });

  it('uses the full-year figure when the post says so', () => {
    expect(evaluateRevenueClaim(claim({ claimedPercent: 28, period: 'year' }), evidence).verdict).toBe('holds_up');
  });
});
