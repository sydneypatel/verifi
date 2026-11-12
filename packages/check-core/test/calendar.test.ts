// Earnings dates and consensus estimates, checked against Finnhub's earnings calendar.
import { describe, expect, it } from 'vitest';
import {
  EMPTY_CLAIM,
  FinnhubClient,
  MemoryCache,
  checkPost,
  createFinnhubCalendarSource,
  createRuleBasedExtractor,
  evaluateCalendarClaim,
  normalizeClaims,
  resolveEventDay,
  type FetchLike,
} from '../src';
import type { CalendarEvidence, Claim } from '../src/types';

// The AMAT post that came back "nothing can be checked".
const AMAT_POST =
  "$AMAT reports earnings today after close\n\nThe implied move is: 6.06%\n\nThe expectations are:\n\nRevenue: $10.3B\nEPS: $4.06\n\nExpect numbers at 4:01PM EST\n\nHere's the Historical Earnings Data 📍";

// Finnhub's real calendar row for AMAT, read Nov 12, 2026.
const AMAT_ROW = { symbol: 'AMAT', date: '2026-11-12', hour: 'amc', quarter: 4, year: 2026, epsEstimate: 4.1345, epsActual: null, revenueEstimate: 10504570449, revenueActual: null };

const evidence: CalendarEvidence = {
  kind: 'earnings_calendar',
  sourceId: 'finnhub-calendar',
  ticker: 'AMAT',
  entityName: 'AMAT',
  asOf: '2026-11-12',
  reports: [
    { date: '2026-08-14', hour: 'amc', fiscalYear: 2026, fiscalQuarter: 3, epsEstimate: 3.9, revenueEstimate: 10.1e9, epsActual: 4.02, revenueActual: 10.2e9 },
    { date: '2026-11-12', hour: 'amc', fiscalYear: 2026, fiscalQuarter: 4, epsEstimate: 4.1345, revenueEstimate: 10504570449, epsActual: null, revenueActual: null },
  ],
  figures: [],
  citation: { label: '', url: '' },
};

const claim = (o: Partial<Claim>): Claim => ({ ...EMPTY_CLAIM, id: 'c1', quote: 'q', type: 'earnings_date', ticker: 'AMAT', postedAt: '2026-11-12', ...o });
const evaluate = (o: Partial<Claim>) => evaluateCalendarClaim(claim(o), evidence, '2026-11-12');

describe('reading the AMAT post', () => {
  it('finds the date, the implied move and both consensus figures', async () => {
    const claims = await createRuleBasedExtractor().extractClaims(AMAT_POST);
    expect(claims.map((c) => [c.type, c.metric, c.claimedAmount ?? c.claimedPercent, c.eventDate, c.session])).toEqual([
      ['earnings_date', null, null, 'today', 'after_hours'],
      ['implied_move', null, 6.06, null, null],
      ['consensus_estimate', 'revenue', 10.3e9, null, null],
      ['consensus_estimate', 'eps', 4.06, null, null],
    ]);
  });

  it('keeps reported figures and beats out of the consensus', async () => {
    const claims = await createRuleBasedExtractor().extractClaims('$AMAT beat expectations. EPS: $4.20. Revenue: $10.6B');
    expect(claims.map((c) => c.type)).not.toContain('consensus_estimate');
  });

  it('cleans model output for the new types', () => {
    const [eps, rev, move] = normalizeClaims([
      { quote: 'EPS: $4.06', type: 'consensus_estimate', claimedAmount: 4.06 },
      { quote: 'Revenue: $10.3B', type: 'consensus_estimate', metric: 'other', claimedAmount: 10.3e9 },
      { quote: 'implied move is 6.06%', type: 'implied_move', claimedPercent: 6.06 },
    ]);
    expect(eps).toMatchObject({ type: 'consensus_estimate', metric: 'eps', claimedAmount: 4.06 });
    expect(rev).toMatchObject({ metric: 'revenue', claimedAmount: 10.3e9 });
    expect(move).toMatchObject({ type: 'implied_move', claimedPercent: 6.06 });
    const [date] = normalizeClaims([{ quote: 'reports Thursday after close', type: 'earnings_date', eventDate: 'Thursday', session: 'after_hours' }]);
    expect(date).toMatchObject({ eventDate: 'Thursday', session: 'after_hours' });
  });
});

describe('event days', () => {
  it('reads days counted forward from the post', () => {
    // Nov 9, 2026 is a Monday.
    expect(resolveEventDay('today', '2026-11-09')).toEqual({ from: '2026-11-09', to: '2026-11-09' });
    expect(resolveEventDay('tomorrow', '2026-11-09')).toEqual({ from: '2026-11-10', to: '2026-11-10' });
    expect(resolveEventDay('Thursday', '2026-11-09')).toEqual({ from: '2026-11-12', to: '2026-11-12' });
    expect(resolveEventDay('this week', '2026-11-11')).toEqual({ from: '2026-11-09', to: '2026-11-13' });
    expect(resolveEventDay('next week', '2026-11-11')).toEqual({ from: '2026-11-16', to: '2026-11-20' });
    expect(resolveEventDay('Nov 19', '2026-11-09')).toEqual({ from: '2026-11-19', to: '2026-11-19' });
    expect(resolveEventDay('Jan 8', '2026-12-20')).toEqual({ from: '2027-01-08', to: '2027-01-08' });
    expect(resolveEventDay('soon', '2026-11-09')).toBeNull();
  });
});

describe('earnings dates', () => {
  it('holds up "today after close" on the report day', () => {
    const r = evaluate({ eventDate: 'today', session: 'after_hours' });
    expect(r.verdict).toBe('holds_up');
    expect(r.reason).toBe("The earnings calendar has AMAT's Q4 2026 report on Nov 12, 2026, after the close.");
  });

  it('counts "Thursday" from the post date', () => {
    expect(evaluate({ eventDate: 'Thursday', postedAt: '2026-11-09' }).verdict).toBe('holds_up');
  });

  it('contradicts the wrong day or the wrong time of day', () => {
    expect(evaluate({ eventDate: 'tomorrow', postedAt: '2026-11-12' }).verdict).toBe('contradicted');
    const early = evaluate({ eventDate: 'today', session: 'pre_market' });
    expect(early.verdict).toBe('contradicted');
    expect(early.reason).toContain('The post says before the open.');
  });

  it("can't check a post that doesn't say when", () => {
    expect(evaluate({}).verdict).toBe('cant_check');
  });
});

describe('consensus estimates', () => {
  it('holds up figures within 3% of the consensus, and says providers differ', () => {
    // $4.06 vs $4.13; $10.3B vs $10.5B: both about 2% apart.
    const eps = evaluate({ type: 'consensus_estimate', metric: 'eps', claimedAmount: 4.06 });
    expect(eps.verdict).toBe('holds_up');
    expect(eps.reason).toContain('The analyst consensus for AMAT\'s Q4 2026 report on Nov 12, 2026, after the close is EPS of $4.13.');
    expect(eps.reason).toContain('differ slightly between data providers');
    expect(evaluate({ type: 'consensus_estimate', metric: 'revenue', claimedAmount: 10.3e9 }).verdict).toBe('holds_up');
  });

  it('is misleading within 10% and contradicted beyond', () => {
    expect(evaluate({ type: 'consensus_estimate', metric: 'revenue', claimedAmount: 9.8e9 }).verdict).toBe('misleading');
    expect(evaluate({ type: 'consensus_estimate', metric: 'revenue', claimedAmount: 8e9 }).verdict).toBe('contradicted');
    expect(evaluate({ type: 'consensus_estimate', metric: 'eps', claimedAmount: 5 }).verdict).toBe('contradicted');
  });

  it('uses the quarter the post names, and mentions what was reported since', () => {
    const r = evaluate({ type: 'consensus_estimate', metric: 'eps', claimedAmount: 3.9, fiscalQuarter: 3, fiscalYear: 2026 });
    expect(r.verdict).toBe('holds_up');
    expect(r.reason).toContain('The company has since reported $4.02.');
  });
});

describe('the AMAT post end to end', () => {
  const finnhubFetch: FetchLike = async (url) => {
    const body = url.includes('/calendar/earnings') && url.includes('symbol=AMAT') ? { earningsCalendar: [AMAT_ROW] } : { earningsCalendar: [] };
    return { ok: true, status: 200, json: async () => body };
  };

  it('checks three of the four claims, and says why the implied move cannot be', async () => {
    const now = () => new Date('2026-11-12T15:00:00Z');
    const finnhub = new FinnhubClient({ apiKey: 'test', fetch: finnhubFetch });
    const r = await checkPost(AMAT_POST, {
      extractor: createRuleBasedExtractor(),
      sources: [createFinnhubCalendarSource({ finnhub, now })],
      cache: new MemoryCache(),
      now,
    });
    expect(r.claims.map((c) => [c.claim.type, c.verdict])).toEqual([
      ['earnings_date', 'holds_up'],
      ['implied_move', 'cant_check'],
      ['consensus_estimate', 'holds_up'],
      ['consensus_estimate', 'holds_up'],
    ]);
    expect(r.claims[1]!.reason).toContain('options');
    expect(r.claims[2]!.evidence?.kind).toBe('earnings_calendar');
  });
});
