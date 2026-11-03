import type { ExtractedClaim } from '../types';

/**
 * The only job the LLM has: read a messy post and list the claims in it.
 * It never supplies facts, numbers or verdicts. Those come from data sources
 * and plain code, which is what keeps hallucination out of the results.
 *
 * Any provider can sit behind this interface.
 */
export interface ClaimExtractor {
  /** Shown in results so you can tell which extractor produced them. */
  name: string;
  extractClaims(postText: string): Promise<ExtractedClaim[]>;
}

/** Three figures read from an earnings press release, before code checks them. */
export interface ReleaseReading {
  /** The end of the quarter, as the release prints it ("October 26, 2025"). */
  periodEndText: string | null;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  revenue: ReleaseFigureReading | null;
  netIncome: ReleaseFigureReading | null;
  eps: ReleaseFigureReading | null;
}

export interface ReleaseFigureReading {
  /** This quarter, in full US dollars (or dollars per share for EPS). */
  current: number;
  /** The same quarter a year earlier, if printed. */
  prior: number | null;
  /** The release text the numbers were copied from, word for word. Code checks it. */
  quote: string;
}

/**
 * Reads an earnings press release. Like the claim extractor, it only reads:
 * every figure it returns is checked against the release text in code.
 */
export interface ReleaseReader {
  name: string;
  read(releaseText: string): Promise<ReleaseReading | null>;
}

export const CLAIM_TYPES = [
  'revenue_growth',
  'financial_figure',
  'short_interest',
  'corporate_event',
  'earnings_result',
  'price_move',
  'market_cap',
  'prediction',
  'opinion',
  'other',
] as const;

export const ESTIMATE_RESULTS = ['beat', 'miss', 'in_line'] as const;

export const PRICE_WINDOWS = ['day', 'week', 'month', 'ytd', 'year'] as const;

export const METRICS = ['revenue', 'net_income', 'other'] as const;

/** Every field of a claim that an extractor may leave empty. Spread this, then override. */
export const EMPTY_CLAIM = {
  ticker: null,
  company: null,
  claimedPercent: null,
  direction: null,
  period: null,
  metric: null,
  claimedAmount: null,
  fiscalYear: null,
  fiscalQuarter: null,
  bound: null,
  vsEstimate: null,
  window: null,
} as const;
