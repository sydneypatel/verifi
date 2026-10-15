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

export const CLAIM_TYPES = ['revenue_growth', 'financial_figure', 'short_interest', 'corporate_event', 'prediction', 'opinion', 'other'] as const;

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
} as const;
