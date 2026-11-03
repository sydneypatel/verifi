import type { Citation, Claim, Evidence, Verdict } from '../types';

export interface Evaluation {
  verdict: Verdict;
  reason: string;
  /** Set when the claim matched an older filing than the one the evidence cites by default. */
  citation?: Citation;
}

/**
 * One data source. To support a new kind of claim, add a file that implements
 * this and register it in the list passed to checkPost(). Nothing else changes.
 */
export interface EvidenceSource {
  id: string;
  /** How long fetched evidence stays fresh. */
  ttlMs: number;
  supports(claim: Claim): boolean;
  /** Claims that share a key share one fetch. */
  cacheKey(claim: Claim): string;
  /** What to tell the user when fetchEvidence returns null. Defaults to "No filing data found". */
  emptyReason?(claim: Claim): string;
  /** Returns null when the source has nothing for this ticker. Throws on network errors. */
  fetchEvidence(claim: Claim): Promise<Evidence | null>;
  /** Pure comparison of claim and evidence. No network, no LLM. */
  evaluate(claim: Claim, evidence: Evidence): Evaluation;
}
