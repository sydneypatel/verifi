import { describe, expect, it } from 'vitest';
import { EMPTY_CLAIM, FinnhubClient, MemoryCache, checkPost, createFinnhubEarningsSource, createFinnhubMarketSource, createRuleBasedExtractor, evaluateEarningsClaim, evaluateMarketClaim, normalizeClaims } from '../src';
import { createFinnhubFixtureFetch } from '../src/fixtures';
import { dayOfMonthInNewYork } from '../src/sources/finnhub/marketSource';
import type { Claim, EarningsEvidence, MarketEvidence } from '../src/types';

const claim = (o: Partial<Claim>): Claim => ({ ...EMPTY_CLAIM, id: 'c1', quote: 'q', type: 'price_move', ticker: 'TGSR', ...o });

const market: MarketEvidence = {
  kind: 'market',
  sourceId: 'finnhub-market',
  ticker: 'TGSR',
  entityName: 'Tallgrass Solar Inc',
  asOf: '2026-11-03',
  readAt: '2026-11-03T16:00:00.000Z',
  price: 18.42,
  returns: { day: 3.42, week: 11.8, month: 6.2, ytd: -14.5, year: -22.1 },
  marketCap: 1.2905e9,
  figures: [],
  citation: { label: '', url: '' },
};

describe('price moves', () => {
  it('holds up when the named window matches', () => {
    const r = evaluateMarketClaim(claim({ claimedPercent: 12, direction: 'up', window: 'week' }), market);
    expect(r.verdict).toBe('holds_up');
    expect(r.reason).toContain('up 11.8% over the past 5 trading days');
    expect(r.reason).toContain('Nov 3, 2026, 11:00 AM ET');
  });

  it('is misleading when the move matches a different window', () => {
    const r = evaluateMarketClaim(claim({ claimedPercent: 12, direction: 'up', window: 'day' }), market);
    expect(r.verdict).toBe('misleading');
    expect(r.reason).toContain('matches the change over the past 5 trading days, not today');
  });

  it('contradicts the wrong direction', () => {
    const r = evaluateMarketClaim(claim({ claimedPercent: 20, direction: 'up', window: 'ytd' }), market);
    expect(r.verdict).toBe('contradicted');
    expect(r.reason).toContain('down 14.5% so far this year');
  });

  it("can't check a move when the post names no period (no searching for a span that fits)", () => {
    const r = evaluateMarketClaim(claim({ claimedPercent: 22, direction: 'down' }), market);
    expect(r.verdict).toBe('cant_check');
    expect(r.reason).toContain("doesn't say over what period");
    // The actual moves are still shown for reference.
    expect(r.reason).toContain('down 22.1% over the past 52 weeks');
  });

  it('checks a floor ("up over 10% this week")', () => {
    expect(evaluateMarketClaim(claim({ claimedPercent: 10, direction: 'up', window: 'week', bound: 'at_least' }), market).verdict).toBe('holds_up');
    expect(evaluateMarketClaim(claim({ claimedPercent: 30, direction: 'up', window: 'week', bound: 'at_least' }), market).verdict).toBe('contradicted');
  });

  it('checks direction only', () => {
    expect(evaluateMarketClaim(claim({ direction: 'up', window: 'day' }), market).verdict).toBe('holds_up');
    expect(evaluateMarketClaim(claim({ direction: 'up', window: 'year' }), market).verdict).toBe('contradicted');
  });

  it("can't check a window the data lacks", () => {
    const r = evaluateMarketClaim(claim({ claimedPercent: 5, direction: 'up', window: 'month' }), { ...market, returns: { day: 1 } });
    expect(r.verdict).toBe('cant_check');
  });
});

describe('market value', () => {
  const cap = (o: Partial<Claim>) => claim({ type: 'market_cap', ...o });
  it('holds up within 10%', () => expect(evaluateMarketClaim(cap({ claimedAmount: 1.3e9 }), market).verdict).toBe('holds_up'));
  it('is misleading within 25%', () => expect(evaluateMarketClaim(cap({ claimedAmount: 1.55e9 }), market).verdict).toBe('misleading'));
  it('contradicts a $5B claim', () => {
    const r = evaluateMarketClaim(cap({ claimedAmount: 5e9 }), market);
    expect(r.verdict).toBe('contradicted');
    expect(r.reason).toContain('worth about $1.29B');
  });
  it('checks a floor', () => expect(evaluateMarketClaim(cap({ claimedAmount: 1e9, bound: 'at_least' }), market).verdict).toBe('holds_up'));
});

const earnings: EarningsEvidence = {
  kind: 'earnings_result',
  sourceId: 'finnhub-earnings',
  ticker: 'NVDA',
  entityName: 'NVDA',
  asOf: '2026-07-26',
  quarters: [
    { period: '2026-07-26', fiscalYear: 2027, fiscalQuarter: 2, actual: 1.05, estimate: 1.01, surprisePercent: 3.96 },
    { period: '2026-04-26', fiscalYear: 2027, fiscalQuarter: 1, actual: 0.96, estimate: 0.96, surprisePercent: 0 },
    { period: '2026-01-25', fiscalYear: 2026, fiscalQuarter: 4, actual: 0.89, estimate: 0.93, surprisePercent: -4.3 },
  ],
  figures: [],
  citation: { label: '', url: '' },
};

describe('earnings', () => {
  const e = (o: Partial<Claim>) => claim({ type: 'earnings_result', ticker: 'NVDA', ...o });

  it('holds up a beat', () => {
    const r = evaluateEarningsClaim(e({ vsEstimate: 'beat' }), earnings);
    expect(r.verdict).toBe('holds_up');
    expect(r.reason).toContain('For fiscal Q2 2027, EPS was $1.05 against an analyst estimate of $1.01, a beat of 4.0%');
    // Finnhub's period date is a calendar approximation, so it is not shown when a fiscal label exists.
    expect(r.reason).not.toContain('Jul 26');
  });

  it('contradicts a claimed miss', () => {
    expect(evaluateEarningsClaim(e({ vsEstimate: 'miss' }), earnings).verdict).toBe('contradicted');
  });

  it('calls an in-line quarter a misleading beat', () => {
    const r = evaluateEarningsClaim(e({ vsEstimate: 'beat', fiscalQuarter: 1, fiscalYear: 2027 }), earnings);
    expect(r.verdict).toBe('misleading');
    expect(r.reason).toContain('matched the estimate');
  });

  it('flags an overstated surprise ("beat by 30%")', () => {
    expect(evaluateEarningsClaim(e({ vsEstimate: 'beat', claimedPercent: 30 }), earnings).verdict).toBe('misleading');
  });

  it('checks a per-share figure, rounding to the cent', () => {
    expect(evaluateEarningsClaim(e({ claimedAmount: 1.05 }), earnings).verdict).toBe('holds_up');
    expect(evaluateEarningsClaim(e({ claimedAmount: 1.5 }), earnings).verdict).toBe('contradicted');
  });

  it('catches a figure from an older quarter', () => {
    const r = evaluateEarningsClaim(e({ claimedAmount: 0.89 }), earnings);
    expect(r.verdict).toBe('misleading');
    expect(r.reason).toContain('not the latest quarter');
  });

  it("can't check a post with no beat, miss or figure", () => {
    expect(evaluateEarningsClaim(e({}), earnings).verdict).toBe('cant_check');
  });
});

describe('extracting the new claim types (rule-based)', () => {
  const extract = (text: string) => createRuleBasedExtractor().extractClaims(text);

  it('reads price moves with their time span', async () => {
    const claims = await extract('$NVDA is up 12% today. Shares fell 30% this year.');
    expect(claims.map((c) => [c.type, c.direction, c.claimedPercent, c.window])).toEqual([
      ['price_move', 'up', 12, 'day'],
      ['price_move', 'down', 30, 'ytd'],
    ]);
  });

  it('keeps revenue growth as revenue, not a price move', async () => {
    const claims = await extract('$NVDA revenue is up 56% this quarter.');
    expect(claims.map((c) => c.type)).toEqual(['revenue_growth']);
  });

  it('reads market value', async () => {
    const claims = await extract('$AAPL is a $3T company. Market cap of $3.5 trillion soon.');
    expect(claims[0]).toMatchObject({ type: 'market_cap', claimedAmount: 3e12 });
  });

  it('reads beats, misses and per-share figures', async () => {
    const claims = await extract('$TSLA missed estimates again. $AMD beat earnings with EPS of $1.25.');
    expect(claims.map((c) => [c.type, c.ticker, c.vsEstimate, c.claimedAmount])).toEqual([
      ['earnings_result', 'TSLA', 'miss', null],
      ['earnings_result', 'AMD', 'beat', 1.25],
    ]);
  });

  it('reads "revenue beat estimates" as a revenue beat, not an EPS claim', async () => {
    const claims = await extract('$AMD revenue beat estimates.');
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ type: 'earnings_result', metric: 'revenue', vsEstimate: 'beat', quote: 'revenue beat estimates' });
  });

  it('normalizes the new fields from model output', () => {
    const [a, b] = normalizeClaims([
      { quote: 'up 40% this week', type: 'price_move', window: 'WEEK', direction: 'up', claimedPercent: 40, claimedAmount: 5 },
      { quote: 'beat', type: 'earnings_result', vsEstimate: 'beat', window: 'day', claimedAmount: 1.2 },
    ]);
    // On a price move, claimedAmount is a share price the post states.
    expect(a).toMatchObject({ window: 'week', vsEstimate: null, claimedAmount: 5 });
    expect(b).toMatchObject({ window: null, vsEstimate: 'beat', claimedAmount: 1.2 });
  });
});

describe('Finnhub sources in the pipeline', () => {
  const finnhub = new FinnhubClient({ apiKey: 'test', fetch: createFinnhubFixtureFetch() });
  const deps = { extractor: createRuleBasedExtractor(), sources: [createFinnhubEarningsSource({ finnhub }), createFinnhubMarketSource({ finnhub })], cache: new MemoryCache() };

  it('checks a price move and a market value end to end', async () => {
    const result = await checkPost('$TGSR is up 12% this week. $TGSR is a $5B company.', deps);
    expect(result.claims.map((c) => [c.claim.type, c.verdict])).toEqual([
      ['price_move', 'holds_up'],
      ['market_cap', 'contradicted'],
    ]);
    expect(result.entityName).toBe('Tallgrass Solar Inc');
  });

  it('leaves out month to date in the first week of a month (Finnhub can still show last month)', async () => {
    // The fixture quote is dated Nov 3.
    const result = await checkPost('$TGSR shares are up 6% this month.', deps);
    expect(result.claims[0]!.verdict).toBe('cant_check');
    expect(result.claims[0]!.reason).toContain("Early in a month the month-to-date figure isn't reliable yet.");
    expect(dayOfMonthInNewYork('2026-11-15T16:00:00Z')).toBe(15);
    // 1 AM UTC on Nov 1 is still Oct 31 in New York.
    expect(dayOfMonthInNewYork('2026-11-01T01:00:00Z')).toBe(31);
  });

  it('says when a symbol has no market data', async () => {
    const result = await checkPost('$ZZZZ is up 12% today.', deps);
    expect(result.claims[0]!.reason).toBe('No market data found for ZZZZ. It may not trade on a US exchange.');
  });
});
