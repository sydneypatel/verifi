import type { ClaimType, Direction, ExtractedClaim, Metric, Period, Quarter } from '../types';
import { CLAIM_TYPES, METRICS } from './types';

const MAX_CLAIMS = 12;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

    const typeText = asString(row.type)?.toLowerCase() ?? 'other';
    const type = (CLAIM_TYPES as readonly string[]).includes(typeText) ? (typeText as ClaimType) : 'other';

    const percent = asNumber(row.claimedPercent);

    const directionText = asString(row.direction)?.toLowerCase();
    const direction: Direction | null = directionText === 'up' || directionText === 'down' ? directionText : null;

    const periodText = asString(row.period)?.toLowerCase();
    const period: Period | null = periodText === 'quarter' || periodText === 'year' ? periodText : null;

    // Dollar-figure fields only mean something on a dollar-figure claim.
    const isFigure = type === 'financial_figure';
    const metricText = asString(row.metric)?.toLowerCase();
    const metric: Metric | null = isFigure
      ? (METRICS as readonly string[]).includes(metricText ?? '')
        ? (metricText as Metric)
        : 'other'
      : null;

    let amount = isFigure ? asNumber(row.claimedAmount) : null;
    // "a $42B net loss" must be negative even if the model returned 42B.
    if (amount !== null && metric === 'net_income' && amount > 0 && /\bloss(es)?\b/i.test(quote)) amount = -amount;

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
      fiscalQuarter: quarter === 1 || quarter === 2 || quarter === 3 || quarter === 4 ? (quarter as Quarter) : null,
    });
    if (claims.length >= MAX_CLAIMS) break;
  }

  return claims;
}
