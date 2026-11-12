import type { Bound, ClaimType, Direction, EstimateResult, ExtractedClaim, Metric, Period, PriceWindow, Quarter } from '../types';
import { CLAIM_TYPES, COMPARISONS, ESTIMATE_RESULTS, METRICS, PRICE_REFERENCES, PRICE_WINDOWS, SESSIONS } from './types';

const MAX_CLAIMS = 40;

// Claim types whose claimedAmount means something: dollars, dollars per share,
// or (price_move) the share price the post states.
const AMOUNT_TYPES: ClaimType[] = ['financial_figure', 'earnings_result', 'consensus_estimate', 'market_cap', 'price_move'];
const METRIC_TYPES: ClaimType[] = ['financial_figure', 'earnings_result', 'consensus_estimate'];
// Claim types that can be about one business line.
const SEGMENT_TYPES: ClaimType[] = ['revenue_growth', 'financial_figure', 'earnings_result'];

// "40% upside", "price target of $300", "PT $250": a forecast, whatever the model called it.
const UPSIDE = /\b(?:\d+(?:\.\d+)?\s?%\s+upside|upside (?:of|to)|price target|pt (?:of )?\$?\d|target (?:of|price)\s+\$?\d)/i;
// "I'm up 40% on this", "my calls printed", "we lost $20K": the poster's own position.
const PERSONAL =
  /^(?:i|i'm|i am|i've|we|we're|my|our)\b[^.!?\n]{0,40}\b(?:made|lost|profits?|bag(?:s|ged)?|portfolio|position|account|calls|puts|gains?|returns?)\b|^(?:i'm|i am|we're|we are)\s+(?:up|down)\b/i;
// "Our revenue is up 30%" is a company claim, even in the first person.
const COMPANY_MEASURE = /\b(?:revenue|revenues|sales|earnings|eps|income|margin|guidance|cash flow)\b/i;

export function isPersonal(quote: string): boolean {
  return PERSONAL.test(quote.trim()) && !COMPANY_MEASURE.test(quote);
}

// Words that make an earnings claim about EPS, and words that make it about something else.
const EARNINGS_WORDS = /\b(?:earnings|eps|per share|profit|bottom line|results|numbers|estimates|expectations|consensus|the street)\b/i;
const OTHER_MEASURE = /\b(?:revenue|revenues|sales|top line|guidance|outlook|forecast|margin|margins|cash flow|fcf|users|subscribers|deliveries|bookings)\b/i;

// Segment names that are really the whole company.
const NOT_A_SEGMENT = /^(?:total|overall|company|consolidated|revenue|revenues|sales|net sales|top line|headline|group|all)$/i;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  const text = asString(value)?.toLowerCase();
  return text && (allowed as readonly string[]).includes(text) ? (text as T) : null;
}

/** "$tgsr" -> "TGSR", "NASDAQ:NVDA" -> "NVDA". Anything that is not 1-5 letters (plus an optional class suffix) is dropped. */
export function normalizeTicker(value: unknown): string | null {
  const raw =
    asString(value)
      ?.replace(/^(?:nasdaq|nyse|nyse american|nysearca|amex|otc|otcmkts|cboe|bats)\s*:\s*/i, '')
      .replace(/^\$/, '')
      .toUpperCase() ?? null;
  return raw && /^[A-Z]{1,5}([.-][A-Z])?$/.test(raw) ? raw : null;
}

/**
 * Model output is untrusted input. Coerce every field, drop anything malformed,
 * and cap the list, so a bad response can never break the pipeline.
 */
export function normalizeClaims(raw: unknown): ExtractedClaim[] {
  const list = Array.isArray(raw) ? raw : [];
  const claims: ExtractedClaim[] = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;

    const quote = asString(row.quote);
    if (!quote) continue;

    let type = oneOf(row.type, CLAIM_TYPES) ?? 'other';
    // Upside and price targets are forecasts. The poster's own gains and losses
    // are set aside. Both whatever the model called them.
    if (type !== 'prediction' && type !== 'consensus_estimate' && UPSIDE.test(quote)) type = 'prediction';
    else if (type !== 'personal' && isPersonal(quote)) type = 'personal';

    const percent = asNumber(row.claimedPercent);
    const direction: Direction | null = oneOf(row.direction, ['up', 'down'] as const);
    const period: Period | null = oneOf(row.period, ['quarter', 'year'] as const);

    // Which measure: only means something on a dollar-figure or earnings claim.
    // Earnings claims default to earnings per share; dollar figures to "other".
    let metric: Metric | null = METRIC_TYPES.includes(type)
      ? (oneOf(row.metric, METRICS) ?? (type === 'earnings_result' ? 'eps' : 'other'))
      : null;
    // A consensus figure is revenue or EPS; anything else isn't in the calendar.
    if (type === 'consensus_estimate' && metric !== 'revenue' && metric !== 'eps') {
      metric = /\b(?:revenue|revenues|sales|top line)\b/i.test(quote) ? 'revenue' : /\b(?:eps|earnings|per share)\b/i.test(quote) ? 'eps' : 'other';
    }
    // "Crushed earnings" is about earnings per share, even when the model says "other".
    if (type === 'earnings_result' && metric === 'other' && EARNINGS_WORDS.test(quote) && !OTHER_MEASURE.test(quote)) metric = 'eps';

    let amount = AMOUNT_TYPES.includes(type) ? asNumber(row.claimedAmount) : null;
    // "a $42B net loss" must be negative even if the model returned 42B.
    if (amount !== null && (metric === 'net_income' || metric === 'operating_income') && amount > 0 && /\bloss(es)?\b/i.test(quote)) amount = -amount;
    // A market value, a change in it, and a share price are never negative.
    if (amount !== null && (type === 'market_cap' || type === 'price_move')) amount = amount <= 0 ? null : amount;

    const bound: Bound | null = oneOf(row.bound, ['at_least', 'at_most'] as const);
    const vsEstimate: EstimateResult | null = type === 'earnings_result' ? oneOf(row.vsEstimate, ESTIMATE_RESULTS) : null;
    const moves = type === 'price_move' || type === 'market_cap';
    const window: PriceWindow | null = moves ? oneOf(row.window, PRICE_WINDOWS) : null;
    const days = moves ? asNumber(row.windowDays) : null;

    const year = asNumber(row.fiscalYear);
    const quarter = asNumber(row.fiscalQuarter);
    const segment = SEGMENT_TYPES.includes(type) ? asString(row.segment)?.slice(0, 60) ?? null : null;

    claims.push({
      quote: quote.slice(0, 300),
      type,
      ticker: normalizeTicker(row.ticker),
      company: asString(row.company)?.slice(0, 80) ?? null,
      claimedPercent: percent === null ? null : Math.abs(percent),
      // Direction says which way a market value moved ("wiped out", "added"), so it stays on market_cap.
      direction,
      period,
      metric,
      claimedAmount: amount,
      fiscalYear: year !== null && Number.isInteger(year) && year >= 1990 && year <= 2100 ? year : null,
      bound,
      fiscalQuarter: quarter === 1 || quarter === 2 || quarter === 3 || quarter === 4 ? (quarter as Quarter) : null,
      vsEstimate,
      window,
      windowDays: days !== null && days > 0 ? Math.round(days) : null,
      session: type === 'price_move' || type === 'earnings_date' ? oneOf(row.session, SESSIONS) : null,
      reference: type === 'price_move' ? oneOf(row.reference, PRICE_REFERENCES) : null,
      comparison: type === 'revenue_growth' || type === 'earnings_result' ? oneOf(row.comparison, COMPARISONS) : null,
      segment: segment && !NOT_A_SEGMENT.test(segment) ? segment : null,
      eventDate: type === 'earnings_date' ? asString(row.eventDate)?.slice(0, 40) ?? null : null,
      postedAt: null,
    });
    if (claims.length >= MAX_CLAIMS) break;
  }

  return claims;
}
