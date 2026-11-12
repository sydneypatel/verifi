// Tests for the fixes found by re-testing real posts, grouped by to-do item.
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_CLAIM,
  FinnhubClient,
  InputError,
  MemoryCache,
  SecClient,
  checkPost,
  companyKey,
  createAnthropicExtractor,
  createFinnhubEarningsSource,
  createFinnhubMarketSource,
  createRuleBasedExtractor,
  createSecFigureSource,
  createSecRevenueSource,
  dedupeClaims,
  evaluateEarningsClaim,
  evaluateFigureClaim,
  evaluateMarketClaim,
  namesMatch,
  normalizeClaims,
  parsePostDate,
  postTickers,
  sharedPostPeriod,
  summarizeRevenue,
  type ClaimExtractor,
  type CompanyDirectory,
  type FetchLike,
} from '../src';
import { createFinnhubFixtureFetch, createFixtureFetch, demoCompanyFacts } from '../src/fixtures';
import { acceptsTemperature } from '../src/llm/anthropicClient';
import type { Claim, EarningsEvidence, ExtractedClaim, FigureEvidence, MarketEvidence } from '../src/types';

// The checks run on Nov 12, 2026. The fixture's price was read Nov 3, 2026, 11:00 AM ET.
const NOW = new Date('2026-11-12T15:00:00Z');
const M = 1_000_000;

function deps(extractor: ClaimExtractor = createRuleBasedExtractor()) {
  const sec = new SecClient({ userAgent: 'test test@example.com', fetch: createFixtureFetch() });
  const finnhub = new FinnhubClient({ apiKey: 'test', fetch: createFinnhubFixtureFetch() });
  return {
    extractor,
    sources: [createSecRevenueSource({ sec }), createSecFigureSource({ sec }), createFinnhubEarningsSource({ finnhub }), createFinnhubMarketSource({ finnhub })],
    cache: new MemoryCache(),
    directory: sec,
    now: () => NOW,
  };
}

const stub = (claims: ExtractedClaim[]): ClaimExtractor => ({ name: 'stub', extractClaims: async () => claims });
const ex = (o: Partial<ExtractedClaim>): ExtractedClaim => ({ ...EMPTY_CLAIM, quote: 'q', type: 'other', ...o });
const claim = (o: Partial<Claim>): Claim => ({ ...EMPTY_CLAIM, id: 'c1', quote: 'q', type: 'price_move', ticker: 'TGSR', ...o });
const extract = (text: string) => createRuleBasedExtractor().extractClaims(text);

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
  high52Week: { price: 26.31, date: '2026-02-11' },
  figures: [],
  citation: { label: '', url: '' },
};

describe('1. the post date', () => {
  it('reads dates the way apps print them, against the day of the check', () => {
    expect(parsePostDate('Nov 9', NOW)).toBe('2026-11-09');
    expect(parsePostDate('Nov 9, 2025', NOW)).toBe('2025-11-09');
    expect(parsePostDate('9 Nov 2025', NOW)).toBe('2025-11-09');
    // A date with no year is never in the future.
    expect(parsePostDate('Dec 3', NOW)).toBe('2025-12-03');
    expect(parsePostDate('2d ago', NOW)).toBe('2026-11-10');
    expect(parsePostDate('3 days ago', NOW)).toBe('2026-11-09');
    // 10 AM ET minus 17 hours is the evening before, in New York.
    expect(parsePostDate('17h', NOW)).toBe('2026-11-11');
    expect(parsePostDate('Monday', NOW)).toBe('2026-11-09');
    expect(parsePostDate('Thursday', NOW)).toBe('2026-11-12');
    expect(parsePostDate('last Thu', NOW)).toBe('2026-11-05');
    expect(parsePostDate('yesterday', NOW)).toBe('2026-11-11');
    expect(parsePostDate('2026-11-09', NOW)).toBe('2026-11-09');
    expect(parsePostDate('2026-11-10T02:00:00Z', NOW)).toBe('2026-11-09');
    expect(parsePostDate('soon', NOW)).toBeNull();
    expect(parsePostDate('Feb 30', NOW)).toBeNull();
  });

  it('puts the post date on every claim and in the result', async () => {
    const r = await checkPost('$TGSR is up 3% today.', deps(), { postedAt: 'Nov 3' });
    expect(r.postedAt).toBe('2026-11-03');
    expect(r.claims[0]!.claim.postedAt).toBe('2026-11-03');
  });

  it('reads "today" against the post date: same day holds up, an older post can\'t be checked', async () => {
    const sameDay = await checkPost('$TGSR is up 3% today.', deps(), { postedAt: 'Nov 3' });
    expect(sameDay.claims[0]!.verdict).toBe('holds_up');

    const older = await checkPost('$TGSR is up 3% today.', deps(), { postedAt: 'Nov 2' });
    expect(older.claims[0]!.verdict).toBe('cant_check');
    expect(older.claims[0]!.reason).toContain('The post is from Nov 2, 2026');
    expect(older.claims[0]!.reason).toContain('as of Nov 3, 2026');
  });

  it('reads the date from a copied X author block when none is given', async () => {
    const post = ['Someone', '@someone', '·', 'Nov 2', '$TGSR is up 3% today.'].join('\n');
    const r = await checkPost(post, deps());
    expect(r.postedAt).toBe('2026-11-02');
    expect(r.claims[0]!.verdict).toBe('cant_check');
  });

  it('refuses a date it cannot read or one in the future', async () => {
    await expect(checkPost('$TGSR is up 3% today.', deps(), { postedAt: 'sometime' })).rejects.toBeInstanceOf(InputError);
    await expect(checkPost('$TGSR is up 3% today.', deps(), { postedAt: '2026-12-01' })).rejects.toBeInstanceOf(InputError);
  });

  it('reads "48 hours" as two days, which the data does not cover', async () => {
    const [c] = await extract('$TGSR is up 8% in the last 48 hours');
    expect(c).toMatchObject({ type: 'price_move', windowDays: 2 });
    const r = evaluateMarketClaim({ ...c!, id: 'c1' }, market);
    expect(r.verdict).toBe('cant_check');
    expect(r.reason).toContain('not 2 days');
  });

  it("can't check pre-market or after-hours moves", async () => {
    const [pre] = await extract('$TGSR is up 8% in premarket trading');
    const [after] = await extract('$TGSR fell 5% after hours');
    expect(pre).toMatchObject({ session: 'pre_market' });
    expect(after).toMatchObject({ session: 'after_hours' });
    for (const c of [pre!, after!]) {
      const r = evaluateMarketClaim({ ...c, id: 'c1', window: 'day' }, market);
      expect(r.verdict).toBe('cant_check');
      expect(r.reason).toContain('regular trading hours only');
    }
  });

  it('checks "revenue of $44M" against the latest quarter filed by the post date', async () => {
    const text = '$TGSR posted revenue of $44M last quarter.';
    // Today the latest quarter is Q2 2026 ($48.2M), but on Jul 1 it was Q1 2026 ($44.0M).
    expect((await checkPost(text, deps())).claims[0]!.verdict).toBe('misleading');
    const dated = await checkPost(text, deps(), { postedAt: '2026-07-01' });
    expect(dated.claims[0]!.verdict).toBe('holds_up');
    expect(dated.claims[0]!.reason).toContain('quarter ended Mar 31, 2026');
  });

  it('checks revenue growth for the latest quarter as of the post date', async () => {
    const r = await checkPost('$TGSR revenue is up 27.5% year over year this quarter.', deps(), { postedAt: '2026-07-01' });
    expect(r.claims[0]!.verdict).toBe('holds_up');
    expect(r.claims[0]!.reason).toContain('quarter ended Mar 31, 2026');
  });
});

describe('2. business-line claims', () => {
  it('flags segments in the post', async () => {
    expect((await extract('$MSFT Azure grew 40% this quarter'))[0]).toMatchObject({ type: 'revenue_growth', segment: 'Azure', claimedPercent: 40 });
    expect((await extract('$BIDU AI Cloud revenue up 30% YoY'))[0]).toMatchObject({ type: 'revenue_growth', segment: 'AI Cloud', quote: 'AI Cloud revenue up 30%' });
    expect((await extract('$META ad revenue rose 26%'))[0]).toMatchObject({ segment: 'ad' });
    expect((await extract('$NVDA data center revenue of $41B'))[0]).toMatchObject({ type: 'financial_figure', segment: 'data center' });
    expect((await extract('$TGSR revenue is up 31%'))[0]).toMatchObject({ segment: null });
  });

  it('never uses total revenue as evidence for a segment', async () => {
    // Total revenue is up 31%, so a total-revenue check would say "holds up".
    const r = await checkPost('$TGSR AI Cloud revenue is up 31% this quarter. Data center revenue of $48.2M.', deps());
    expect(r.claims.map((c) => [c.claim.segment, c.verdict, c.evidence])).toEqual([
      ['AI Cloud', 'cant_check', null],
      ['Data center', 'cant_check', null],
    ]);
    expect(r.claims[0]!.reason).toContain('one business line (AI Cloud)');
  });

  it('treats "total" from the model as the whole company', () => {
    const [c] = normalizeClaims([{ quote: 'revenue up 31%', type: 'revenue_growth', segment: 'total', claimedPercent: 31, direction: 'up' }]);
    expect(c!.segment).toBeNull();
  });
});

describe('3. the right period and revenue line', () => {
  it('stops at the basis the claim names, even when the model also says "year"', async () => {
    const r = await checkPost('post', {
      ...deps(stub([ex({ quote: 'Q2 revenue up 31% YoY', type: 'revenue_growth', ticker: 'TGSR', claimedPercent: 31, direction: 'up', period: 'year', comparison: 'yoy', fiscalQuarter: 2 })])),
    });
    expect(r.claims[0]!.verdict).toBe('holds_up');
    expect(r.claims[0]!.reason).not.toContain('full fiscal year');
    expect(r.claims[0]!.reason).toContain('compared with a year earlier');
  });

  it('accepts either year-over-year figure when the post names no period', async () => {
    const yoy = (claimedPercent: number) => ex({ quote: 'revenue up YoY', type: 'revenue_growth', ticker: 'TGSR', claimedPercent, direction: 'up', comparison: 'yoy' });
    const r = await checkPost('post', deps(stub([yoy(31), yoy(28)])));
    expect(r.claims.map((c) => c.verdict)).toEqual(['holds_up', 'holds_up']);
  });

  it('reads QoQ as quarter over quarter', async () => {
    const [c] = await extract('$TGSR revenue up 9.5% QoQ');
    expect(c).toMatchObject({ comparison: 'qoq', period: 'quarter' });
    const r = await checkPost('$TGSR revenue up 9.5% QoQ. $TGSR revenue up 31% QoQ.', deps());
    expect(r.claims[0]!.verdict).toBe('holds_up');
    expect(r.claims[0]!.reason).toContain('compared with the quarter before');
    // 31% is the year-over-year figure, not the QoQ one the post names.
    expect(r.claims[1]!.verdict).toBe('misleading');
  });

  it('checks the quarter the post names, not the latest one', async () => {
    const r = await checkPost('$TGSR Q1 2026 revenue up 27.5% year over year.', deps());
    expect(r.claims[0]!.verdict).toBe('holds_up');
    expect(r.claims[0]!.reason).toContain('quarter ended Mar 31, 2026');
  });

  it('says a quarter newer than the latest filing is not filed yet', async () => {
    const r = await checkPost('$TGSR Q3 2026 revenue up 40%. Q3 2026 revenue of $55M. $TGSR beat estimates in Q4 2026.', deps());
    expect(r.claims.map((c) => [c.claim.type, c.verdict])).toEqual([
      ['revenue_growth', 'cant_check'],
      ['financial_figure', 'cant_check'],
      ['earnings_result', 'cant_check'],
    ]);
    expect(r.claims[0]!.reason).toContain("Q3 2026 isn't filed yet");
    expect(r.claims[0]!.reason).toContain('quarter ended Jun 30, 2026');
    expect(r.claims[1]!.reason).toContain("Q3 2026 isn't filed yet");
    expect(r.claims[2]!.reason).toContain("Q4 2026 isn't reported yet");
  });

  it('uses total revenue when a company also tags part of it (Vistra)', () => {
    const facts = structuredClone(demoCompanyFacts);
    const gaap = facts.facts['us-gaap']!;
    // Contract revenue is a part; Revenues is the total, for the same periods.
    const contract = gaap['RevenueFromContractWithCustomerExcludingAssessedTax']!.units['USD']!;
    gaap['Revenues'] = { units: { USD: contract.map((f) => ({ ...f, val: f.val * 1.5 })) } };
    const summary = summarizeRevenue(facts)!;
    expect(summary.concept).toBe('Revenues');
    expect(summary.quarters[0]!.value).toBeCloseTo(72.3 * M, -4);
  });

  it('applies a period stated in the post ("Apr–Jun 2025") to every claim in it', async () => {
    expect(sharedPostPeriod([], 'Results for Apr–Jun 2026 are in')).toMatchObject({ fiscalYear: 2026, fiscalQuarter: 2, period: 'quarter' });
    expect(sharedPostPeriod([], 'April to June 2026')).toMatchObject({ fiscalQuarter: 2 });
    expect(sharedPostPeriod([], 'Jan-Dec 2025')).toMatchObject({ fiscalYear: 2025, fiscalQuarter: null, period: 'year' });
    expect(sharedPostPeriod([], 'three months ended June 30, 2025')).toMatchObject({ fiscalYear: 2025, fiscalQuarter: 2 });
    expect(sharedPostPeriod([], 'Mar–May 2026')).toBeNull();

    const r = await checkPost('$TGSR Apr–Jun 2025 results: revenue of $36.8M. Net loss was $9.8M. Revenue is up 6.7% QoQ.', deps());
    expect(r.claims.map((c) => [c.claim.fiscalYear, c.claim.fiscalQuarter, c.verdict])).toEqual([
      [2025, 2, 'holds_up'],
      [2025, 2, 'holds_up'],
      [2025, 2, 'holds_up'],
    ]);
    expect(r.claims[1]!.reason).toContain('The post names Q2 2025 earlier');
  });
});

describe('4. price matching with a margin', () => {
  it('holds up only within 10% of the claimed figure', () => {
    expect(evaluateMarketClaim(claim({ claimedPercent: 12, direction: 'up', window: 'week' }), market).verdict).toBe('holds_up');
    // 14% vs 11.8%: within the old 3-point band, outside 10% of 14.
    const off = evaluateMarketClaim(claim({ claimedPercent: 14, direction: 'up', window: 'week' }), market);
    expect(off.verdict).toBe('misleading');
    expect(off.reason).toContain('overstated');
    expect(evaluateMarketClaim(claim({ claimedPercent: 25, direction: 'up', window: 'week' }), market).verdict).toBe('contradicted');
  });

  it('compares "down X% from highs" with the 52-week high', async () => {
    const [c] = await extract('$TGSR is down 30% from its highs');
    expect(c).toMatchObject({ reference: 'high', claimedPercent: 30, direction: 'down' });
    // $18.42 is 30.0% below $26.31.
    const r = evaluateMarketClaim(claim({ claimedPercent: 30, direction: 'down', reference: 'high_52_week' }), market);
    expect(r.verdict).toBe('holds_up');
    expect(r.reason).toContain('30.0% below its 52-week high of $26.31, reached Feb 11, 2026');
    expect(evaluateMarketClaim(claim({ claimedPercent: 30, direction: 'down', reference: 'high' }), market).verdict).toBe('holds_up');
    expect(evaluateMarketClaim(claim({ claimedPercent: 10, direction: 'down', reference: 'high' }), market).verdict).toBe('contradicted');
    // A bigger drop than from the 52-week high may be from an older high: not checkable.
    expect(evaluateMarketClaim(claim({ claimedPercent: 60, direction: 'down', reference: 'high' }), market).verdict).toBe('cant_check');
    expect(evaluateMarketClaim(claim({ claimedPercent: 60, direction: 'down', reference: 'high_52_week' }), market).verdict).toBe('contradicted');
    expect(evaluateMarketClaim(claim({ claimedPercent: 60, direction: 'down', reference: 'high_all_time' }), market).verdict).toBe('cant_check');
  });

  it('checks "from highs" end to end with the fetched 52-week high', async () => {
    const r = await checkPost('$TGSR is down 30% from its highs', deps(), { postedAt: 'Nov 3' });
    expect(r.claims[0]!.verdict).toBe('holds_up');
  });

  it("can't check windows longer than 52 weeks or with no start", async () => {
    const [years] = await extract('$TGSR stock is up 300% in 3 years');
    expect(years!.windowDays).toBe(1095);
    expect(evaluateMarketClaim({ ...years!, id: 'c1' }, market).verdict).toBe('cant_check');
    const [ipo] = await extract('$TGSR shares are down 80% since IPO');
    expect(ipo!.windowDays).toBe(36500);
    const r = evaluateMarketClaim({ ...ipo!, id: 'c1' }, market);
    expect(r.verdict).toBe('cant_check');
    expect(r.reason).toContain('only goes back 52 weeks');
  });
});

describe('5. evidence must match the measure', () => {
  const earnings: EarningsEvidence = {
    kind: 'earnings_result',
    sourceId: 'finnhub-earnings',
    ticker: 'TGSR',
    entityName: 'TGSR',
    asOf: '2026-06-30',
    quarters: [{ period: '2026-06-30', fiscalYear: 2026, fiscalQuarter: 2, actual: -0.09, estimate: -0.11, surprisePercent: 18.18 }],
    figures: [],
    citation: { label: '', url: '' },
  };

  it('never takes an EPS beat as proof of a revenue, guidance or cash-flow claim', async () => {
    const r = await checkPost('$TGSR revenue beat estimates. $TGSR guidance beat expectations. $TGSR crushed earnings.', deps());
    expect(r.claims.map((c) => [c.claim.metric, c.verdict, c.evidence?.kind ?? null])).toEqual([
      ['revenue', 'cant_check', null],
      ['guidance', 'cant_check', null],
      ['eps', 'holds_up', 'earnings_result'],
    ]);
    expect(r.claims[0]!.reason).toContain('an EPS beat says nothing about revenue');
    const fcf = await checkPost('post', deps(stub([ex({ quote: 'FCF beat', type: 'earnings_result', ticker: 'TGSR', metric: 'free_cash_flow', vsEstimate: 'beat' })])));
    expect(fcf.claims[0]!.verdict).toBe('cant_check');
  });

  it('reads a vague "crushed earnings" as EPS even when the model says other', () => {
    const [vague, margins] = normalizeClaims([
      { quote: 'just crushed earnings', type: 'earnings_result', metric: 'other', vsEstimate: 'beat' },
      { quote: 'margins beat estimates', type: 'earnings_result', metric: 'other', vsEstimate: 'beat' },
    ]);
    expect(vague!.metric).toBe('eps');
    expect(margins!.metric).toBe('other');
  });

  it('treats EPS growth as growth, not a beat', async () => {
    const [c] = await extract('$TGSR EPS grew 40% year over year');
    expect(c).toMatchObject({ type: 'earnings_result', metric: 'eps', vsEstimate: null, claimedPercent: 40, direction: 'up' });
    const r = evaluateEarningsClaim({ ...c!, id: 'c1' }, earnings);
    expect(r.verdict).toBe('cant_check');
    expect(r.reason).toContain('EPS growth, not a beat or miss');
  });

  it('keeps operating income separate from net income', async () => {
    const [op] = await extract('$TGSR reported an operating loss of $4.1M in Q2 2026');
    expect(op).toMatchObject({ type: 'financial_figure', metric: 'operating_income', claimedAmount: -4.1 * M });
    const r = await checkPost('$TGSR operating loss of $4.1M in Q2 2026. Net loss was $4.1M in Q2 2026.', deps());
    expect(r.claims.map((c) => [c.claim.metric, c.verdict])).toEqual([
      ['operating_income', 'holds_up'],
      ['net_income', 'contradicted'],
    ]);
    expect(r.claims[0]!.reason).toContain('an operating loss of $4.1M');
    expect(r.claims[1]!.reason).toContain('a net loss of $6.2M');
  });

  it('checks "$X wiped out" as the move times the market value', async () => {
    const [c] = await extract('$TGSR: $220M in market value wiped out this year');
    expect(c).toMatchObject({ type: 'market_cap', direction: 'down', claimedAmount: 220 * M, window: 'ytd' });
    // Down 14.5% this year on $1.29B now: about $219M lost.
    const lost = evaluateMarketClaim(claim({ type: 'market_cap', claimedAmount: 220 * M, direction: 'down', window: 'ytd' }), market);
    expect(lost.verdict).toBe('holds_up');
    expect(lost.reason).toContain('lost about $218.9M in market value so far this year');
    // The whole market value is not the amount wiped out.
    expect(evaluateMarketClaim(claim({ type: 'market_cap', claimedAmount: 1.29e9, direction: 'down', window: 'ytd' }), market).verdict).toBe('contradicted');
    // Up 3.42% today: about $42.7M added, nothing wiped out.
    expect(evaluateMarketClaim(claim({ type: 'market_cap', claimedAmount: 42 * M, direction: 'up', window: 'day' }), market).verdict).toBe('holds_up');
    expect(evaluateMarketClaim(claim({ type: 'market_cap', claimedAmount: 42 * M, direction: 'down', window: 'day' }), market).verdict).toBe('contradicted');
    expect(evaluateMarketClaim(claim({ type: 'market_cap', claimedAmount: 42 * M, direction: 'down' }), market).verdict).toBe('cant_check');
  });

  it('treats upside targets as predictions and sets aside personal gains', async () => {
    const [upside, mine, ours] = normalizeClaims([
      { quote: '$NVDA has 40% upside from here', type: 'price_move', claimedPercent: 40, direction: 'up' },
      { quote: "I'm up 40% on my NVDA calls", type: 'price_move', claimedPercent: 40, direction: 'up' },
      { quote: 'Our revenue is up 30%', type: 'revenue_growth', claimedPercent: 30, direction: 'up' },
    ]);
    expect(upside!.type).toBe('prediction');
    expect(mine!.type).toBe('personal');
    expect(ours!.type).toBe('revenue_growth');

    const r = await checkPost("$TGSR has 50% upside to $28. I'm up 40% on my TGSR shares.", deps());
    expect(r.claims.map((c) => c.claim.type)).toEqual(['prediction', 'personal']);
    expect(r.claims[1]!.reason).toBe("The poster's own gain or loss, not a fact about the company.");
  });

  it('ties each claim to its own company (SoftBank and NVIDIA)', async () => {
    const directory: CompanyDirectory = {
      titleOf: async (t) => ({ NVDA: 'NVIDIA CORP' })[t] ?? null,
      findByName: async (n) => (namesMatch(n, 'NVIDIA CORP') ? { ticker: 'NVDA', title: 'NVIDIA CORP' } : null),
    };
    const claims = [
      ex({ quote: 'SoftBank sold its entire $NVDA stake for $5.8B', type: 'corporate_event', ticker: 'NVDA', company: 'SoftBank' }),
      ex({ quote: 'SoftBank shares fell 10% today', type: 'price_move', company: 'SoftBank', claimedPercent: 10, direction: 'down', window: 'day' }),
      ex({ quote: 'NVIDIA is up 3% today', type: 'price_move', ticker: 'NVDA', company: 'NVIDIA', claimedPercent: 3, direction: 'up', window: 'day' }),
    ];
    const r = await checkPost('post', { ...deps(stub(claims)), directory });
    expect(r.claims.map((c) => c.claim.ticker)).toEqual([null, null, 'NVDA']);
    expect(r.claims[0]!.reason).toContain('No stock ticker found for SoftBank');
    expect(r.claims[1]!.reason).toContain('No stock ticker found for SoftBank');
  });
});

describe('6. coverage and extraction gaps', () => {
  const tickerList: FetchLike = async (url) => {
    if (url !== 'https://www.sec.gov/files/company_tickers.json') return { ok: false, status: 404, json: async () => ({}) };
    const rows = [
      { cik_str: 1, ticker: 'BV', title: 'BrightView Holdings, Inc.' },
      { cik_str: 2, ticker: 'CRWV', title: 'CoreWeave, Inc.' },
      { cik_str: 3, ticker: 'NBIS', title: 'Nebius Group N.V.' },
      { cik_str: 4, ticker: 'GOOGL', title: 'Alphabet Inc.' },
      { cik_str: 4, ticker: 'GOOG', title: 'Alphabet Inc.' },
      { cik_str: 5, ticker: 'ACMA', title: 'Acme Holdings Inc' },
      { cik_str: 6, ticker: 'ACMB', title: 'Acme Corp' },
      { cik_str: 7, ticker: 'NVDA', title: 'NVIDIA CORP' },
    ];
    return { ok: true, status: 200, json: async () => Object.fromEntries(rows.map((r, i) => [String(i), r])) };
  };

  it('finds tickers from company names in the SEC list', async () => {
    const sec = new SecClient({ userAgent: 'test test@example.com', fetch: tickerList });
    expect(await sec.findByName('BrightView')).toMatchObject({ ticker: 'BV' });
    expect(await sec.findByName('CoreWeave')).toMatchObject({ ticker: 'CRWV' });
    expect(await sec.findByName('Nebius')).toMatchObject({ ticker: 'NBIS' });
    expect(await sec.findByName('Nvidia')).toMatchObject({ ticker: 'NVDA' });
    // Two share classes are one company; two companies with one name are a guess.
    expect(await sec.findByName('Alphabet')).toMatchObject({ ticker: 'GOOGL' });
    expect(await sec.findByName('Acme')).toBeNull();
    expect(await sec.findByName('SoftBank')).toBeNull();
    expect(companyKey('BrightView Holdings, Inc.')).toBe('brightview');
    expect(namesMatch('NVIDIA', 'NVIDIA CORP')).toBe(true);
    expect(namesMatch('SoftBank', 'NVIDIA CORP')).toBe(false);
  });

  it('checks a claim that names the company but no ticker', async () => {
    const r = await checkPost('post', deps(stub([ex({ quote: 'revenue up 31%', type: 'revenue_growth', company: 'Tallgrass Solar', claimedPercent: 31, direction: 'up' })])));
    expect(r.claims[0]).toMatchObject({ verdict: 'holds_up', claim: { ticker: 'TGSR' } });
  });

  it('uses $ tickers and chart labels in the post', async () => {
    expect(postTickers('NASDAQ: CRWV · 1D\n$nbis and NYSE:VST')).toEqual(['NBIS', 'CRWV', 'VST']);
    const r = await checkPost('Text in image: NASDAQ: TGSR\nRevenue is up 31% this quarter.', deps());
    expect(r.claims[0]).toMatchObject({ verdict: 'holds_up', claim: { ticker: 'TGSR' } });
    // A cashtag in the claim's own words, even when the model gave no ticker.
    const own = await checkPost('post', deps(stub([ex({ quote: '$TGSR revenue up 31%', type: 'revenue_growth', claimedPercent: 31, direction: 'up' })])));
    expect(own.claims[0]!.claim.ticker).toBe('TGSR');
  });

  it('checks current-price claims instead of saying market data is not connected', async () => {
    const [c] = await extract('$TGSR is trading at $18.50');
    expect(c).toMatchObject({ type: 'price_move', claimedAmount: 18.5, claimedPercent: null });
    const r = await checkPost('$TGSR is trading at $18.50', deps(), { postedAt: 'Nov 3' });
    expect(r.claims[0]!.verdict).toBe('holds_up');
    expect(r.claims[0]!.reason).toContain('$18.42');
    // A price claim with nothing to compare still gets a specific reason.
    const vague = await checkPost('post', deps(stub([ex({ quote: '$TGSR is moving', type: 'price_move', ticker: 'TGSR' })])));
    expect(vague.claims[0]!.reason).not.toContain("isn't connected");
  });

  it('extracts every item in a list', async () => {
    const lines = await extract('$TGSR Q2 2026:\n• Revenue of $48.2M\n• Net loss of $6.2M\n• Revenue up 31% YoY\n• Operating loss of $4.1M');
    expect(lines.map((c) => c.metric ?? c.type)).toEqual(['revenue', 'net_income', 'revenue_growth', 'operating_income']);
    const inline = await extract('$TGSR revenue of $48.2M; net loss of $6.2M | revenue up 31%');
    expect(inline).toHaveLength(3);
  });

  it('removes duplicate claims', async () => {
    const twice = [
      ex({ quote: 'Revenue up 31%', type: 'revenue_growth', ticker: 'TGSR', claimedPercent: 31, direction: 'up' }),
      ex({ quote: 'revenue grew 31%', type: 'revenue_growth', ticker: 'TGSR', claimedPercent: 31, direction: 'up' }),
      ex({ quote: 'To the moon', type: 'opinion' }),
      ex({ quote: 'to the moon!', type: 'opinion' }),
      ex({ quote: 'Revenue up 10%', type: 'revenue_growth', ticker: 'TGSR', claimedPercent: 10, direction: 'up' }),
    ];
    expect(dedupeClaims(twice).map((c) => c.quote)).toEqual(['Revenue up 31%', 'To the moon', 'Revenue up 10%']);
    const r = await checkPost('post', deps(stub(twice)));
    expect(r.summary.total).toBe(3);
    expect(r.claims.map((c) => c.claim.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('pins the model settings so re-runs give the same answer', async () => {
    const reply = { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"claims":[]}' }] }) };
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => reply);
    await createAnthropicExtractor({ apiKey: 'k', fetch: fetchMock as unknown as typeof fetch }).extractClaims('x');
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.temperature).toBe(0);
    // Newer models reject sampling parameters, so none is sent to them.
    await createAnthropicExtractor({ apiKey: 'k', model: 'claude-haiku-5-5', fetch: fetchMock as unknown as typeof fetch }).extractClaims('x');
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body).temperature).toBeUndefined();
    expect(acceptsTemperature('claude-sonnet-4-6')).toBe(true);
    expect(acceptsTemperature('claude-opus-5-5')).toBe(false);
  });

  it('keeps the extraction schema within the API limit of 16 nullable fields', async () => {
    const reply = { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"claims":[]}' }] }) };
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => reply);
    await createAnthropicExtractor({ apiKey: 'k', fetch: fetchMock as unknown as typeof fetch }).extractClaims('x');
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    const fields = body.output_config.format.schema.properties.claims.items.properties as Record<string, { anyOf?: unknown }>;
    expect(Object.values(fields).filter((f) => f.anyOf).length).toBeLessThanOrEqual(16);
    // "none" from the model reads as no value.
    const [c] = normalizeClaims([{ quote: 'up 5% today', type: 'price_move', session: 'none', reference: 'none', claimedPercent: 5, direction: 'up' }]);
    expect(c).toMatchObject({ session: null, reference: null });
  });
});

describe('figure evaluation with no post date is unchanged', () => {
  it('still accepts the latest quarter or year', () => {
    const evidence = {
      kind: 'financial_figure',
      sourceId: 'sec-figure',
      ticker: 'X',
      entityName: 'X',
      asOf: '2026-06-30',
      metric: 'revenue',
      cik: 1,
      quarters: [{ kind: 'quarter', start: '2026-04-01', end: '2026-06-30', value: 10 * M, fiscalYear: 2026, fiscalQuarter: 2, derived: false, filing: { accession: 'a', form: '10-Q', filed: '2026-08-01' } }],
      years: [],
      figures: [],
      citation: { label: '', url: '' },
    } satisfies FigureEvidence;
    expect(evaluateFigureClaim(claim({ type: 'financial_figure', metric: 'revenue', claimedAmount: 10 * M }), evidence).verdict).toBe('holds_up');
  });
});
