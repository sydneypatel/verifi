import type { EvidenceCache } from './cache';
import type { ClaimExtractor } from './llm/types';
import type { EvidenceSource } from './sources/types';
import type { CheckResult, CheckedClaim, Claim, ClaimType, Evidence } from './types';

// Shown when a claim is factual but no data source covers its type yet.
const NOT_BUILT_YET: Partial<Record<ClaimType, string>> = {
  financial_figure: 'HypeCheck can only check revenue and net income figures so far.',
  short_interest: "HypeCheck can't check short interest yet.",
};

export const MAX_POST_LENGTH = 6000;

export interface CheckDeps {
  extractor: ClaimExtractor;
  sources: EvidenceSource[];
  cache?: EvidenceCache;
  now?: () => Date;
}

export class InputError extends Error {}

/**
 * The whole product in one function:
 *   1. the extractor reads the post and lists its claims
 *   2. each claim is routed to the data source that can check it
 *   3. the source fetches evidence (cached) and compares it with the claim
 * Clients send text in and render the CheckResult that comes out.
 */
export async function checkPost(postText: string, deps: CheckDeps): Promise<CheckResult> {
  const text = postText.trim();
  if (!text) throw new InputError('Paste a post to check.');
  if (text.length > MAX_POST_LENGTH) {
    throw new InputError(`That post is too long. The limit is ${MAX_POST_LENGTH} characters.`);
  }

  const extracted = await deps.extractor.extractClaims(text);

  // A post is usually about one stock; claims that do not name it inherit it.
  const postTicker = extracted.find((c) => c.ticker)?.ticker ?? null;
  const postCompany = extracted.find((c) => c.company)?.company ?? null;
  const claims: Claim[] = extracted.map((c, i) => ({
    ...c,
    id: `c${i + 1}`,
    ticker: c.ticker ?? postTicker,
    company: c.company ?? postCompany,
  }));

  // Several claims about one company share a single fetch within this check.
  const inFlight = new Map<string, Promise<Evidence | null>>();

  const fetchEvidence = async (source: EvidenceSource, claim: Claim): Promise<Evidence | null> => {
    const key = source.cacheKey(claim);
    const cached = await deps.cache?.get(key);
    if (cached) return cached;

    let pending = inFlight.get(key);
    if (!pending) {
      pending = source.fetchEvidence(claim).then(async (evidence) => {
        if (evidence) await deps.cache?.set(key, evidence, source.ttlMs);
        return evidence;
      });
      inFlight.set(key, pending);
    }
    return pending;
  };

  const checkOne = async (claim: Claim): Promise<CheckedClaim> => {
    const cant = (reason: string): CheckedClaim => ({ claim, verdict: 'cant_check', reason, evidence: null });

    if (claim.type === 'prediction') return cant('A projection or plan, not a fact to verify.');
    if (claim.type === 'opinion') return cant('An opinion, not a fact to verify.');

    // Without a ticker there are no filings to look up. This is the usual
    // result for private companies and for "leaked" documents.
    if (!claim.ticker) {
      return cant(
        claim.company
          ? `No stock ticker found for ${claim.company}. If it isn't publicly listed, there are no SEC filings to check this against.`
          : "The post doesn't say which company this is about.",
      );
    }

    const source = deps.sources.find((s) => s.supports(claim));
    if (!source) return cant(NOT_BUILT_YET[claim.type] ?? "HypeCheck can't check this kind of claim yet.");

    try {
      const evidence = await fetchEvidence(source, claim);
      if (!evidence) return cant(`No filing data found for ${claim.ticker}.`);
      const { verdict, reason, citation } = source.evaluate(claim, evidence);
      return { claim, verdict, reason, evidence: citation ? { ...evidence, citation } : evidence };
    } catch {
      // One source being down should not fail the whole check.
      return cant("Couldn't reach the data source. Try again in a minute.");
    }
  };

  const checked = await Promise.all(claims.map(checkOne));
  const checkable = checked.filter((c) => c.verdict !== 'cant_check');

  return {
    ticker: postTicker,
    entityName: checked.find((c) => c.evidence)?.evidence?.entityName ?? postCompany,
    claims: checked,
    summary: {
      total: checked.length,
      checkable: checkable.length,
      holdsUp: checkable.filter((c) => c.verdict === 'holds_up').length,
    },
    extractor: deps.extractor.name,
    checkedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
}
