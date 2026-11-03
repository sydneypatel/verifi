import { describe, expect, it } from 'vitest';
import { checkPost } from '../src/pipeline';
import type { Claim, ExtractedClaim } from '../src/types';

const base: ExtractedClaim = { quote: '', type: 'financial_figure', ticker: null, company: null, claimedPercent: null, direction: null, period: null, metric: 'revenue', claimedAmount: null, fiscalYear: null, fiscalQuarter: null, bound: null, vsEstimate: null, window: null };
const c = (o: Partial<ExtractedClaim>): ExtractedClaim => ({ ...base, ...o });

// Fake SEC source: FY2025 MSFT = 281.7B, latest (FY2026) = 331.8B.
const REV: Record<string, Record<number, number>> = { MSFT: { 2025: 281.7e9, 2026: 331.8e9 }, NVDA: { 2025: 130.5e9, 2026: 200e9 } };
const seen: Claim[] = [];
const source = {
  ttlMs: 0,
  supports: () => true,
  cacheKey: (cl: Claim) => cl.ticker!,
  fetchEvidence: async (cl: Claim) => ({ ticker: cl.ticker } as any),
  evaluate: (cl: Claim) => {
    seen.push(cl);
    const yr = cl.fiscalYear ?? 2026;
    const actual = REV[cl.ticker!]![yr]!;
    const ok = cl.bound === 'at_least' ? actual >= cl.claimedAmount! : Math.abs(actual - cl.claimedAmount!) / actual < 0.05;
    return { verdict: ok ? ('holds_up' as const) : ('contradicted' as const), reason: `FY${yr} revenue ${actual}.` };
  },
};
const run = (claims: ExtractedClaim[]) => checkPost('post', { extractor: { name: 't', extractClaims: async () => claims }, sources: [source as any] });

describe('period borrowing', () => {
  it('screenshot post: MSFT "over $280B" is checked against FY2025', async () => {
    const r = await run([
      c({ quote: 'made $130B in revenue in FY2025', ticker: 'NVDA', claimedAmount: 130e9, fiscalYear: 2025, period: 'year' }),
      c({ quote: 'made over $280B', ticker: 'MSFT', claimedAmount: 280e9, bound: 'at_least' }),
      c({ quote: 'NVIDIA is growing like crazy', type: 'opinion', ticker: 'NVDA', metric: null }),
    ]);
    expect(r.claims[1]!.claim.fiscalYear).toBe(2025);
    expect(r.claims[1]!.claim.period).toBe('year');
    expect(r.claims[1]!.reason).toContain('FY2025 revenue 281700000000');
    expect(r.claims[1]!.reason).toContain('The post names FY2025 earlier');
    expect(r.claims[0]!.reason).not.toContain('earlier');
  });

  it('a false figure is now caught in the right year', async () => {
    const r = await run([
      c({ quote: 'made $130B in FY2025', ticker: 'NVDA', claimedAmount: 130e9, fiscalYear: 2025, period: 'year' }),
      c({ quote: 'made over $300B', ticker: 'MSFT', claimedAmount: 300e9, bound: 'at_least' }),
    ]);
    expect(r.claims[1]!.verdict).toBe('contradicted'); // was "holds up" against FY2026's 331.8B
  });

  it('does not borrow when the post names two different periods', async () => {
    const r = await run([
      c({ quote: 'FY2025 revenue $130B', ticker: 'NVDA', claimedAmount: 130e9, fiscalYear: 2025 }),
      c({ quote: 'FY2026 revenue $200B', ticker: 'NVDA', claimedAmount: 200e9, fiscalYear: 2026 }),
      c({ quote: 'made over $280B', ticker: 'MSFT', claimedAmount: 280e9, bound: 'at_least' }),
    ]);
    expect(r.claims[2]!.claim.fiscalYear).toBeNull();
  });

  it('does not borrow when the quote picks its own period', async () => {
    const r = await run([
      c({ quote: 'made $130B in FY2025', ticker: 'NVDA', claimedAmount: 130e9, fiscalYear: 2025 }),
      c({ quote: 'MSFT is making over $300B now', ticker: 'MSFT', claimedAmount: 300e9, bound: 'at_least' }),
      c({ quote: 'last year MSFT made $280B', ticker: 'MSFT', claimedAmount: 280e9 }),
    ]);
    expect(r.claims[1]!.claim.fiscalYear).toBeNull();
    expect(r.claims[2]!.claim.fiscalYear).toBeNull();
  });

  it('borrows a quarter too', async () => {
    const r = await run([
      c({ quote: 'Q2 2026 revenue of $11.5B', ticker: 'MSFT', claimedAmount: 11.5e9, fiscalYear: 2026, fiscalQuarter: 2, period: 'quarter' }),
      c({ quote: 'net income of $2B', ticker: 'MSFT', metric: 'net_income', claimedAmount: 2e9 }),
    ]);
    expect(r.claims[1]!.claim).toMatchObject({ fiscalYear: 2026, fiscalQuarter: 2, period: 'quarter' });
  });

  it('leaves opinions and predictions alone', async () => {
    const r = await run([
      c({ quote: 'made $130B in FY2025', ticker: 'NVDA', claimedAmount: 130e9, fiscalYear: 2025 }),
      c({ quote: 'going to $300', type: 'prediction', ticker: 'NVDA', metric: null }),
    ]);
    expect(r.claims[1]!.claim.fiscalYear).toBeNull();
  });
});
