import { describeChange, formatPercentMagnitude, formatPrice, formatSignedPercent, formatTime, formatUsd } from '../../format';
import type { Claim, Evidence, EvidenceFigure, MarketEvidence, PriceWindow } from '../../types';
import type { Evaluation, EvidenceSource } from '../types';
import type { FinnhubClient } from './client';

// Checks "the stock is up 40% this week" and "a $3T company" against Finnhub's
// latest price data. Unlike filings, prices change all day, so every reason
// says when the price was read, and evidence is only cached for five minutes.

// A post is usually older than the check, so price moves get wider bands than
// filed figures. Tune these against real posts.
export const PRICE_TIGHT_POINTS = 3;
export const PRICE_TIGHT_RELATIVE = 0.2;
export const PRICE_LOOSE_POINTS = 8;
export const PRICE_LOOSE_RELATIVE = 0.4;
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

const STALE_NOTE = ' Prices move all day, so the post may have been right when it was written.';

const within = (claimed: number, actual: number, points: number, relative: number) =>
  Math.abs(claimed - actual) <= Math.max(points, Math.abs(actual) * relative);

function moveText(evidence: MarketEvidence, w: PriceWindow): string {
  return `${describeChange(evidence.returns[w]!)} ${WINDOW_WORDS[w]}`;
}

function evaluatePriceMove(claim: Claim, evidence: MarketEvidence): Evaluation {
  const at = `as of ${formatTime(evidence.readAt)}`;
  const available = WINDOWS.filter((w) => typeof evidence.returns[w] === 'number');
  if (available.length === 0) return { verdict: 'cant_check', reason: `No recent price changes found for ${evidence.ticker}.` };
  if (claim.claimedPercent === null && claim.direction === null) {
    return { verdict: 'cant_check', reason: "The post doesn't say how the price moved, so there is nothing to compare." };
  }
  if (claim.window && !available.includes(claim.window)) {
    const early = claim.window === 'month' ? " Early in a month the month-to-date figure isn't reliable yet." : '';
    return { verdict: 'cant_check', reason: `The market data doesn't include ${evidence.ticker}'s change ${WINDOW_WORDS[claim.window]}.${early}` };
  }

  const sign = claim.direction === 'down' ? -1 : 1;
  const primary = claim.window ?? available[0]!;
  const actualText = (w: PriceWindow) => `${evidence.entityName} stock is ${moveText(evidence, w)} (${at}).`;

  // "The stock is up" with no number: only the direction can be checked.
  if (claim.claimedPercent === null) {
    const actual = evidence.returns[primary]!;
    const same = Math.sign(actual) === sign || actual === 0;
    return { verdict: same ? 'holds_up' : 'contradicted', reason: `${actualText(primary)}${same ? '' : STALE_NOTE}` };
  }

  const claimed = sign * claim.claimedPercent;
  const claimedText = `${claim.bound === 'at_least' ? 'more than ' : claim.bound === 'at_most' ? 'less than ' : ''}${formatPercentMagnitude(claimed)} ${claim.direction === 'down' ? 'drop' : 'gain'}`;
  const tight = (w: PriceWindow) => {
    const actual = evidence.returns[w]!;
    if (claim.bound === 'at_least') return sign * actual >= claim.claimedPercent! - Math.max(PRICE_TIGHT_POINTS, claim.claimedPercent! * PRICE_TIGHT_RELATIVE);
    if (claim.bound === 'at_most') return sign * actual <= claim.claimedPercent! + PRICE_TIGHT_POINTS && Math.sign(actual) !== -sign;
    return within(claimed, actual, PRICE_TIGHT_POINTS, PRICE_TIGHT_RELATIVE);
  };
  const loose = (w: PriceWindow) => {
    const actual = evidence.returns[w]!;
    return Math.sign(actual) === sign && within(claimed, actual, PRICE_LOOSE_POINTS, PRICE_LOOSE_RELATIVE);
  };

  if (claim.window) {
    if (tight(primary)) return { verdict: 'holds_up', reason: actualText(primary) };
    const other = available.find((w) => w !== primary && tight(w));
    if (other) {
      return {
        verdict: 'misleading',
        reason: `A ${claimedText} matches the change ${WINDOW_WORDS[other]}, not ${WINDOW_WORDS[primary]}. ${actualText(primary)}`,
      };
    }
    if (loose(primary)) {
      const how = Math.abs(claimed) > Math.abs(evidence.returns[primary]!) ? 'overstated' : 'understated';
      return { verdict: 'misleading', reason: `Close, but ${how}. ${actualText(primary)}${STALE_NOTE}` };
    }
    return { verdict: 'contradicted', reason: `${actualText(primary)} The post says a ${claimedText} ${WINDOW_WORDS[primary]}.${STALE_NOTE}` };
  }

  // No time span in the post: any recent span that matches counts, but say which.
  const hit = available.find(tight);
  if (hit) {
    return { verdict: 'holds_up', reason: `${actualText(hit)} The post doesn't say over what period, and this is the span that matches.` };
  }
  const near = available.find(loose);
  if (near) {
    const how = Math.abs(claimed) > Math.abs(evidence.returns[near]!) ? 'overstated' : 'understated';
    return { verdict: 'misleading', reason: `Close, but ${how}. ${actualText(near)}${STALE_NOTE}` };
  }
  const all = available.map((w) => moveText(evidence, w)).join(', ');
  return {
    verdict: 'contradicted',
    reason: `No recent period shows a ${claimedText}. ${evidence.entityName} stock is ${all} (${at}).${STALE_NOTE}`,
  };
}

function evaluateMarketCap(claim: Claim, evidence: MarketEvidence): Evaluation {
  const claimed = claim.claimedAmount;
  if (claimed === null) return { verdict: 'cant_check', reason: "The post doesn't give a market value to compare." };
  if (evidence.marketCap === null) return { verdict: 'cant_check', reason: `No market value found for ${evidence.ticker}.` };

  const actual = evidence.marketCap;
  const actualText = `${evidence.entityName} is worth about ${formatUsd(actual)} (market value, ${'as of ' + formatTime(evidence.readAt)}).`;
  const b = claim.bound === 'at_least' ? 'more than ' : claim.bound === 'at_most' ? 'less than ' : '';

  if (claim.bound) {
    const ok = claim.bound === 'at_least' ? actual >= claimed * (1 - CAP_TIGHT) : actual <= claimed * (1 + CAP_TIGHT);
    return ok
      ? { verdict: 'holds_up', reason: actualText }
      : { verdict: 'contradicted', reason: `${actualText} The post says ${b}${formatUsd(claimed)}.` };
  }

  const gap = Math.abs(claimed - actual) / actual;
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

    supports: (claim) =>
      (claim.type === 'price_move' && (claim.claimedPercent !== null || claim.direction !== null)) ||
      (claim.type === 'market_cap' && claim.claimedAmount !== null),

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
