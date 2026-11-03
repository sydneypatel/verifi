import type { Bound, ClaimType, Direction, EstimateResult, ExtractedClaim, Metric, Period, PriceWindow, Quarter } from '../types';
import { CLAIM_TYPES, ESTIMATE_RESULTS, METRICS, PRICE_WINDOWS } from './types';

const MAX_CLAIMS = 20;

// Claim types whose claimedAmount means something (dollars, or dollars per share).
const AMOUNT_TYPES: ClaimType[] = ['financial_figure', 'earnings_result', 'market_cap'];

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

/** "$tgsr" -> "TGSR". Anything that is not 1-5 letters (plus an optional class suffix) is dropped. */
export function normalizeTicker(value: unknown): string | null {
  const raw = asString(value)?.replace(/^\$/, '').toUpperCase() ?? null;
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

    const type = oneOf(row.type, CLAIM_TYPES) ?? 'other';

    const percent = asNumber(row.claimedPercent);
    const direction: Direction | null = oneOf(row.direction, ['up', 'down'] as const);
    const period: Period | null = oneOf(row.period, ['quarter', 'year'] as const);

    // Dollar-figure fields only mean something on a dollar-figure claim.
    const isFigure = type === 'financial_figure';
    const metric: Metric | null = isFigure ? (oneOf(row.metric, METRICS) ?? 'other') : null;

    let amount = AMOUNT_TYPES.includes(type) ? asNumber(row.claimedAmount) : null;
    // "a $42B net loss" must be negative even if the model returned 42B.
    if (amount !== null && metric === 'net_income' && amount > 0 && /\bloss(es)?\b/i.test(quote)) amount = -amount;
    // A market value is never negative.
    if (amount !== null && type === 'market_cap' && amount <= 0) amount = null;

    const bound: Bound | null = oneOf(row.bound, ['at_least', 'at_most'] as const);
    const vsEstimate: EstimateResult | null = type === 'earnings_result' ? oneOf(row.vsEstimate, ESTIMATE_RESULTS) : null;
    const window: PriceWindow | null = type === 'price_move' ? oneOf(row.window, PRICE_WINDOWS) : null;

    const year = asNumber(row.fiscalYear);
    const quarter = asNumber(row.fiscalQuarter);

    claims.push({
      quote: quote.slice(0, 300),
      type,
      ticker: normalizeTicker(row.ticker),
      company: asString(row.company)?.slice(0, 80) ?? null,
      claimedPercent: percent === null ? null : Math.abs(percent),
      direction,
      period,
      metric,
      claimedAmount: amount,
      fiscalYear: year !== null && Number.isInteger(year) && year >= 1990 && year <= 2100 ? year : null,
      bound,
      fiscalQuarter: quarter === 1 || quarter === 2 || quarter === 3 || quarter === 4 ? (quarter as Quarter) : null,
      vsEstimate,
      window,
    });
    if (claims.length >= MAX_CLAIMS) break;
  }

  return claims;
}
