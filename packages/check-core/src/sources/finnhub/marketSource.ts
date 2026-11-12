import { daysBetween, newYorkDate } from '../../dates';
import { describeChange, formatDate, formatPercentMagnitude, formatPrice, formatSignedPercent, formatTime, formatUsd } from '../../format';
import type { Claim, Evidence, EvidenceFigure, MarketEvidence, PriceWindow } from '../../types';
import type { Evaluation, EvidenceSource } from '../types';
import type { FinnhubClient } from './client';

// Checks "the stock is up 40% this week" and "a $3T company" against Finnhub's
// latest price data. Unlike filings, prices change all day, so every reason
// says when the price was read, and evidence is only cached for five minutes.

// A price claim holds up only when it agrees with the data within 10% of the
// claimed figure (with half a point of slack for rounding small moves). Up to
// 25% off is "close, but". Tune these against real posts.
export const PRICE_TOLERANCE = 0.1;
export const PRICE_MIN_POINTS = 0.5;
export const PRICE_LOOSE = 0.25;
export const CAP_TIGHT = 0.1;
export const CAP_LOOSE = 0.25;

const WINDOWS: PriceWindow[] = ['day', 'week', 'month', 'ytd', 'year'];

const WINDOW_WORDS: Record<PriceWindow, string> = {
  day: 'today',
  week: 'over the past 5 trading days',
  month: 'so far this month',
  ytd: 'so far this year',
  year: 'over the past 52 weeks',
};

// Finnhub's /stock/metric field for each window ("today" comes from /quote).
const METRIC_FIELD: Partial<Record<PriceWindow, string>> = {
  week: '5DayPriceReturnDaily',
  month: 'monthToDatePriceReturnDaily',
  ytd: 'yearToDatePriceReturnDaily',
  year: '52WeekPriceReturnDaily',
};

/**
 * How many days the post may be older than the price data and still be checked.
 * "Up 12% today" written on Monday says nothing about Wednesday's move, and the
 * five-day change shifts every session. Longer spans drift slowly.
 */
const MAX_LAG_DAYS: Record<PriceWindow | 'price' | 'high', number> = { day: 0, week: 0, price: 0, high: 1, month: 1, ytd: 3, year: 3 };

export const STALE_NOTE = ' Prices move all day, so the post may have been right when it was written.';

/** Within the margin of the claimed figure. */
export const agrees = (claimed: number, actual: number, margin = PRICE_TOLERANCE) =>
  Math.abs(claimed - actual) <= Math.max(Math.abs(claimed) * margin, PRICE_MIN_POINTS);

function moveText(evidence: MarketEvidence, w: PriceWindow): string {
  return `${describeChange(evidence.returns[w]!)} ${WINDOW_WORDS[w]}`;
}

/** Spans in days that one of the data's windows covers. */
export function windowForDays(days: number): PriceWindow | null {
  if (days === 1) return 'day';
  if (days === 5 || days === 7) return 'week';
  if (days >= 360 && days <= 366) return 'year';
  return null;
}

/** Why a post's date rules out this comparison, or null if it doesn't. */
function staleReason(claim: Claim, evidence: MarketEvidence, kind: PriceWindow | 'price' | 'high', what: string): string | null {
  if (!claim.postedAt) return null;
  const readDay = newYorkDate(new Date(evidence.readAt));
  const lag = daysBetween(claim.postedAt, readDay);
  // Negative: the latest price predates the post (a weekend), so it is the post's latest session too.
  if (lag <= MAX_LAG_DAYS[kind]) return null;
  return `The post is from ${formatDate(claim.postedAt)}, but the market data shows ${evidence.ticker} as of ${formatDate(readDay)}, so ${what} on the post's date can't be checked.`;
}

function claimedWords(claim: Claim, claimed: number): string {
  const b = claim.bound === 'at_least' ? 'more than ' : claim.bound === 'at_most' ? 'less than ' : '';
  return `${b}${formatPercentMagnitude(claimed)} ${claim.direction === 'down' ? 'drop' : 'gain'}`;
}

/** "Down 30% from its highs": compared with the 52-week high. */
function evaluateFromHigh(claim: Claim, evidence: MarketEvidence): Evaluation {
  if (claim.reference === 'high_all_time') {
    return { verdict: 'cant_check', reason: "The market data only goes back 52 weeks, so a move from the all-time high can't be checked." };
  }
  const high = evidence.high52Week;
  if (!high || evidence.price === null || claim.claimedPercent === null) {
    return { verdict: 'cant_check', reason: `No 52-week high found for ${evidence.ticker}.` };
  }
  const stale = staleReason(claim, evidence, 'high', 'the distance from the high');
  if (stale) return { verdict: 'cant_check', reason: stale };

  const below = ((high.price - evidence.price) / high.price) * 100;
  const when = high.date ? `, reached ${formatDate(high.date)}` : '';
  const actualText = `${evidence.entityName} stock is ${formatPrice(evidence.price)}, ${formatPercentMagnitude(below)} below its 52-week high of ${formatPrice(high.price)}${when} (as of ${formatTime(evidence.readAt)}).`;
  const claimed = claim.claimedPercent;

  if (agrees(claimed, below)) return { verdict: 'holds_up', reason: actualText };
  // "Its highs" with no span: an older all-time high could explain a bigger drop, never a smaller one.
  if (claim.reference === 'high' && claimed > below) {
    return {
      verdict: 'cant_check',
      reason: `${actualText} The post may mean an older high than the past 52 weeks, which the market data doesn't cover.`,
    };
  }
  if (agrees(claimed, below, PRICE_LOOSE)) {
    return { verdict: 'misleading', reason: `Close, but ${claimed > below ? 'overstated' : 'understated'}. ${actualText}${STALE_NOTE}` };
  }
  return { verdict: 'contradicted', reason: `${actualText} The post says ${formatPercentMagnitude(claimed)} below the high.${STALE_NOTE}` };
}

/** "Trading at $182": the share price itself. */
function evaluatePrice(claim: Claim, evidence: MarketEvidence): Evaluation {
  const claimed = claim.claimedAmount!;
  if (evidence.price === null) return { verdict: 'cant_check', reason: `No current price found for ${evidence.ticker}.` };
  const stale = staleReason(claim, evidence, 'price', 'the share price');
  if (stale) return { verdict: 'cant_check', reason: stale };
  const actualText = `${evidence.entityName} stock is ${formatPrice(evidence.price)} (as of ${formatTime(evidence.readAt)}).`;
  const gap = Math.abs(claimed - evidence.price) / claimed;
  if (gap <= PRICE_TOLERANCE) return { verdict: 'holds_up', reason: actualText };
  if (gap <= PRICE_LOOSE) return { verdict: 'misleading', reason: `Close, but ${claimed > evidence.price ? 'overstated' : 'understated'}. ${actualText}${STALE_NOTE}` };
  return { verdict: 'contradicted', reason: `${actualText} The post says ${formatPrice(claimed)}.${STALE_NOTE}` };
}

/** The window the claim names, from its word or its length in days, or why it can't be checked. */
function claimWindow(claim: Claim, evidence: MarketEvidence, available: PriceWindow[]): { window: PriceWindow } | { reason: string } {
  const all = available.map((w) => moveText(evidence, w)).join(', ');
  const context = all ? ` For reference, ${evidence.entityName} stock is ${all} (as of ${formatTime(evidence.readAt)}).` : '';
  if (claim.window) return { window: claim.window };
  if (claim.windowDays !== null) {
    if (claim.windowDays > 366) return { reason: `The market data only goes back 52 weeks, so a move over a longer span can't be checked.` };
    const w = windowForDays(claim.windowDays);
    if (w) return { window: w };
    return { reason: `The market data has changes for today, 5 trading days, this month, this year and 52 weeks, not ${claim.windowDays} days.${context}` };
  }
  return { reason: `The post doesn't say over what period, so there is no change to compare.${context}` };
}

function evaluatePriceMove(claim: Claim, evidence: MarketEvidence): Evaluation {
  if (claim.session) {
    const when = claim.session === 'pre_market' ? 'Pre-market' : 'After-hours';
    return { verdict: 'cant_check', reason: `${when} prices aren't in the market data, which covers regular trading hours only.` };
  }
  if (claim.reference) return evaluateFromHigh(claim, evidence);
  if (claim.claimedPercent === null && claim.direction === null) {
    if (claim.claimedAmount !== null) return evaluatePrice(claim, evidence);
    return { verdict: 'cant_check', reason: "The post doesn't say how the price moved, so there is nothing to compare." };
  }

  const available = WINDOWS.filter((w) => typeof evidence.returns[w] === 'number');
  if (available.length === 0) return { verdict: 'cant_check', reason: `No recent price changes found for ${evidence.ticker}.` };
  const resolved = claimWindow(claim, evidence, available);
  if ('reason' in resolved) return { verdict: 'cant_check', reason: resolved.reason };
  const named = resolved.window;
  if (!available.includes(named)) {
    const early = named === 'month' ? " Early in a month the month-to-date figure isn't reliable yet." : '';
    return { verdict: 'cant_check', reason: `The market data doesn't include ${evidence.ticker}'s change ${WINDOW_WORDS[named]}.${early}` };
  }
  const stale = staleReason(claim, evidence, named, `a move ${WINDOW_WORDS[named]}`);
  if (stale) return { verdict: 'cant_check', reason: stale };

  const at = `as of ${formatTime(evidence.readAt)}`;
  const sign = claim.direction === 'down' ? -1 : 1;
  const actualText = (w: PriceWindow) => `${evidence.entityName} stock is ${moveText(evidence, w)} (${at}).`;
  const actual = evidence.returns[named]!;

  // "The stock is up" with no number: only the direction can be checked.
  if (claim.claimedPercent === null) {
    const same = Math.sign(actual) === sign || actual === 0;
    return { verdict: same ? 'holds_up' : 'contradicted', reason: `${actualText(named)}${same ? '' : STALE_NOTE}` };
  }

  const claimed = sign * claim.claimedPercent;
  const claimedText = claimedWords(claim, claim.claimedPercent);
  const margin = (c: number) => Math.max(Math.abs(c) * PRICE_TOLERANCE, PRICE_MIN_POINTS);
  const tight = (w: PriceWindow) => {
    const r = evidence.returns[w]!;
    if (claim.bound === 'at_least') return sign * r >= claim.claimedPercent! - margin(claimed);
    if (claim.bound === 'at_most') return sign * r <= claim.claimedPercent! + margin(claimed) && Math.sign(r) !== -sign;
    return agrees(claimed, r);
  };

  if (tight(named)) return { verdict: 'holds_up', reason: actualText(named) };
  const other = available.find((w) => w !== named && tight(w));
  if (other) {
    return {
      verdict: 'misleading',
      reason: `A ${claimedText} matches the change ${WINDOW_WORDS[other]}, not ${WINDOW_WORDS[named]}. ${actualText(named)}`,
    };
  }
  if (Math.sign(actual) === sign && agrees(claimed, actual, PRICE_LOOSE)) {
    const how = Math.abs(claimed) > Math.abs(actual) ? 'overstated' : 'understated';
    return { verdict: 'misleading', reason: `Close, but ${how}. ${actualText(named)}${STALE_NOTE}` };
  }
  return { verdict: 'contradicted', reason: `${actualText(named)} The post says a ${claimedText} ${WINDOW_WORDS[named]}.${STALE_NOTE}` };
}

/** "$500B wiped out today": the move over the window times the market value, not the value itself. */
function evaluateCapChange(claim: Claim, evidence: MarketEvidence): Evaluation {
  const claimed = claim.claimedAmount!;
  if (evidence.marketCap === null) return { verdict: 'cant_check', reason: `No market value found for ${evidence.ticker}.` };
  const available = WINDOWS.filter((w) => typeof evidence.returns[w] === 'number');
  const resolved = claimWindow(claim, evidence, available);
  if ('reason' in resolved) return { verdict: 'cant_check', reason: resolved.reason.replace('no change to compare', 'no change in value to compare') };
  const named = resolved.window;
  const r = evidence.returns[named];
  if (typeof r !== 'number') return { verdict: 'cant_check', reason: `The market data doesn't include ${evidence.ticker}'s change ${WINDOW_WORDS[named]}.` };
  const stale = staleReason(claim, evidence, named, `the change in value ${WINDOW_WORDS[named]}`);
  if (stale) return { verdict: 'cant_check', reason: stale };

  const before = evidence.marketCap / (1 + r / 100);
  const change = evidence.marketCap - before;
  const verb = change < 0 ? 'lost' : 'gained';
  const actualText = `${evidence.entityName} ${verb} about ${formatUsd(Math.abs(change))} in market value ${WINDOW_WORDS[named]} (${describeChange(r)} on a value of about ${formatUsd(evidence.marketCap)}, as of ${formatTime(evidence.readAt)}).`;
  const claimedText = `${formatUsd(claimed)} ${claim.direction === 'down' ? 'wiped out' : 'added'}`;

  if ((claim.direction === 'down') !== change < 0) return { verdict: 'contradicted', reason: `${actualText} The post says ${claimedText}.${STALE_NOTE}` };
  const gap = Math.abs(claimed - Math.abs(change)) / claimed;
  if (gap <= CAP_TIGHT) return { verdict: 'holds_up', reason: actualText };
  if (gap <= CAP_LOOSE) return { verdict: 'misleading', reason: `Close, but ${claimed > Math.abs(change) ? 'overstated' : 'understated'}. ${actualText}${STALE_NOTE}` };
  return { verdict: 'contradicted', reason: `${actualText} The post says ${claimedText}.${STALE_NOTE}` };
}

function evaluateMarketCap(claim: Claim, evidence: MarketEvidence): Evaluation {
  const claimed = claim.claimedAmount;
  if (claimed === null) return { verdict: 'cant_check', reason: "The post doesn't give a market value to compare." };
  if (claim.direction) return evaluateCapChange(claim, evidence);
  if (evidence.marketCap === null) return { verdict: 'cant_check', reason: `No market value found for ${evidence.ticker}.` };
  const stale = staleReason(claim, evidence, 'month', 'the market value');
  if (stale) return { verdict: 'cant_check', reason: stale };

  const actual = evidence.marketCap;
  const actualText = `${evidence.entityName} is worth about ${formatUsd(actual)} (market value, ${'as of ' + formatTime(evidence.readAt)}).`;
  const b = claim.bound === 'at_least' ? 'more than ' : claim.bound === 'at_most' ? 'less than ' : '';

  if (claim.bound) {
    const ok = claim.bound === 'at_least' ? actual >= claimed * (1 - CAP_TIGHT) : actual <= claimed * (1 + CAP_TIGHT);
    return ok
      ? { verdict: 'holds_up', reason: actualText }
      : { verdict: 'contradicted', reason: `${actualText} The post says ${b}${formatUsd(claimed)}.` };
  }

  const gap = Math.abs(claimed - actual) / claimed;
  if (gap <= CAP_TIGHT) return { verdict: 'holds_up', reason: actualText };
  if (gap <= CAP_LOOSE) {
    return { verdict: 'misleading', reason: `Close, but ${claimed > actual ? 'overstated' : 'understated'}. ${actualText}` };
  }
  return { verdict: 'contradicted', reason: `${actualText} The post says ${formatUsd(claimed)}.` };
}

/** Pure comparison of a price or market-value claim with the market data. */
export function evaluateMarketClaim(claim: Claim, evidence: MarketEvidence): Evaluation {
  return claim.type === 'market_cap' ? evaluateMarketCap(claim, evidence) : evaluatePriceMove(claim, evidence);
}

function figuresFor(e: MarketEvidence): EvidenceFigure[] {
  const rows: EvidenceFigure[] = [];
  if (e.price !== null) rows.push({ label: 'Share price', value: formatPrice(e.price) });
  for (const w of WINDOWS) {
    const r = e.returns[w];
    if (typeof r === 'number') rows.push({ label: `Change ${WINDOW_WORDS[w]}`, value: formatSignedPercent(r) });
  }
  if (e.high52Week) rows.push({ label: '52-week high', value: formatPrice(e.high52Week.price) });
  if (e.marketCap !== null) rows.push({ label: 'Market value', value: formatUsd(e.marketCap) });
  return rows;
}

/** The day of the month in New York, where US markets keep time. */
export function dayOfMonthInNewYork(iso: string): number {
  return Number(new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', day: 'numeric' }));
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function createFinnhubMarketSource({ finnhub, now = () => new Date() }: { finnhub: FinnhubClient; now?: () => Date }): EvidenceSource {
  return {
    id: 'finnhub-market',
    ttlMs: 5 * 60 * 1000,

    // Every price and market-value claim comes here, so each gets a specific
    // answer (a verdict, or why it can't be checked) instead of "not connected".
    supports: (claim) => claim.type === 'price_move' || claim.type === 'market_cap',

    cacheKey: (claim) => `finnhub-market:${claim.ticker ?? ''}`,

    emptyReason: (claim) => `No market data found for ${claim.ticker}. It may not trade on a US exchange.`,

    async fetchEvidence(claim): Promise<Evidence | null> {
      if (!claim.ticker) return null;
      const [quote, profile, metrics] = await Promise.all([
        finnhub.quote(claim.ticker),
        finnhub.profile(claim.ticker),
        finnhub.metrics(claim.ticker),
      ]);
      // Finnhub answers an unknown symbol with zeros, not a 404.
      if (!quote?.c && !profile?.name) return null;

      const m = metrics?.metric ?? {};
      const returns: MarketEvidence['returns'] = {};
      const day = num(quote?.dp);
      if (day !== null && quote?.c) returns.day = day;
      const readAt = quote?.t ? new Date(quote.t * 1000).toISOString() : now().toISOString();
      for (const [w, field] of Object.entries(METRIC_FIELD) as Array<[PriceWindow, string]>) {
        const value = num(m[field]);
        if (value !== null) returns[w] = value;
      }
      // Finnhub's metrics carry no date and can lag a day or more. Early in a month,
      // "month to date" may still be last month's figure (seen: -10.4% on the 1st
      // trading day of November, when the day's move was -1.3%), so it is left out.
      if (dayOfMonthInNewYork(readAt) <= 7) delete returns.month;

      const capMillions = num(profile?.marketCapitalization) ?? num(m['marketCapitalization']);
      const highPrice = num(m['52WeekHigh']);
      const highDate = typeof m['52WeekHighDate'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m['52WeekHighDate']) ? m['52WeekHighDate'] : null;

      const evidence: MarketEvidence = {
        kind: 'market',
        sourceId: 'finnhub-market',
        ticker: claim.ticker,
        entityName: profile?.name || claim.ticker,
        asOf: readAt.slice(0, 10),
        readAt,
        price: quote?.c ? quote.c : null,
        returns,
        marketCap: capMillions === null ? null : capMillions * 1e6,
        high52Week: highPrice !== null && highPrice > 0 ? { price: highPrice, date: highDate } : null,
        figures: [],
        citation: {
          label: `Finnhub market data, ${formatTime(readAt)}`,
          url: `https://finance.yahoo.com/quote/${encodeURIComponent(claim.ticker)}/`,
        },
      };
      evidence.figures = figuresFor(evidence);
      return evidence;
    },

    evaluate(claim, evidence) {
      if (evidence.kind !== 'market') return { verdict: 'cant_check', reason: 'The data found does not match this claim.' };
      return evaluateMarketClaim(claim, evidence);
    },
  };
}
