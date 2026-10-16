import type { EvidenceCache } from './cache';
import type { ClaimExtractor } from './llm/types';
import type { EvidenceSource } from './sources/types';
import { cleanPostText } from './text';
import type { CheckResult, CheckedClaim, Claim, ClaimType, Evidence, ExtractedClaim, Period, Quarter } from './types';

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

// Claim types whose check depends on which year or quarter is meant.
const DATED_TYPES: ClaimType[] = ['financial_figure', 'revenue_growth'];

// Words that mean the quote picks its own period, so it must not borrow one.
const OWN_PERIOD = /\b(?:fy\s?'?\d{2,4}|q[1-4]|20\d\d|quarter|year|annual|annually|ttm|trailing|ytd|month|week|today|yesterday|recently|now|currently)\b/i;

interface PostPeriod {
  fiscalYear: number;
  fiscalQuarter: Quarter | null;
  period: Period | null;
}

/**
 * "$NVDA made $130B in FY2025 while $MSFT made over $280B": the second figure
 * means FY2025 too, but the extractor gives it no year, and a source then
 * checks it against the latest year instead. When every dated figure in the
 * post names the same period, undated figures borrow it. If the post names
 * two different periods, nothing is borrowed, since a guess could be wrong.
 */
export function sharedPostPeriod(claims: ExtractedClaim[]): PostPeriod | null {
  const dated = claims.filter((c) => DATED_TYPES.includes(c.type) && c.fiscalYear !== null);
  if (dated.length === 0) return null;
  const first = dated[0]!;
  const same = dated.every((c) => c.fiscalYear === first.fiscalYear && c.fiscalQuarter === first.fiscalQuarter);
  if (!same) return null;
  return { fiscalYear: first.fiscalYear!, fiscalQuarter: first.fiscalQuarter, period: first.period ?? (first.fiscalQuarter ? 'quarter' : 'year') };
}

function borrowsPeriod(c: ExtractedClaim): boolean {
  return DATED_TYPES.includes(c.type) && c.fiscalYear === null && c.fiscalQuarter === null && !OWN_PERIOD.test(c.quote);
}

function periodLabel(p: PostPeriod): string {
  return p.fiscalQuarter ? `Q${p.fiscalQuarter} ${p.fiscalYear}` : `FY${p.fiscalYear}`;
}

/**
 * The whole product in one function:
 *   1. the extractor reads the post and lists its claims
 *   2. each claim is routed to the data source that can check it
 *   3. the source fetches evidence (cached) and compares it with the claim
 * Clients send text in and render the CheckResult that comes out.
 */
export async function checkPost(postText: string, deps: CheckDeps): Promise<CheckResult> {
  const text = cleanPostText(postText);
  if (!text) throw new InputError('Paste a post to check.');
  if (text.length > MAX_POST_LENGTH) {
    throw new InputError(`That post is too long. The limit is ${MAX_POST_LENGTH} characters.`);
  }

  const extracted = await deps.extractor.extractClaims(text);

  // Claims that name no stock inherit the post's stock, but only when the
  // post is about exactly one. In a multi-stock post a guess could be wrong.
  const tickers = [...new Set(extracted.map((c) => c.ticker).filter((t): t is string => Boolean(t)))];
  const companies = [...new Set(extracted.map((c) => c.company).filter((t): t is string => Boolean(t)))];
  const onlyTicker = tickers.length === 1 ? tickers[0]! : null;
  const onlyCompany = companies.length === 1 ? companies[0]! : null;
  const postTicker = tickers[0] ?? null;
  const postCompany = companies[0] ?? null;
  const postPeriod = sharedPostPeriod(extracted);

  // Claim ids whose year or quarter came from elsewhere in the post.
  const borrowed = new Set<string>();
  const claims: Claim[] = extracted.map((c, i) => {
    const id = `c${i + 1}`;
    const claim: Claim = { ...c, id, ticker: c.ticker ?? onlyTicker, company: c.company ?? onlyCompany };
    if (postPeriod && borrowsPeriod(c)) {
      borrowed.add(id);
      claim.fiscalYear = postPeriod.fiscalYear;
      claim.fiscalQuarter = postPeriod.fiscalQuarter;
      claim.period = postPeriod.period;
    }
    return claim;
  });

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

    if (claim.type === 'prediction') return cant('A prediction or price target, not a fact to verify.');
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
      // Say so when the period was read from elsewhere in the post, so a
      // reader can see why this year was used and not the latest one.
      const fullReason =
        borrowed.has(claim.id) && postPeriod && verdict !== 'cant_check'
          ? `${reason} The post names ${periodLabel(postPeriod)} earlier, so this figure is checked against that period.`
          : reason;
      return { claim, verdict, reason: fullReason, evidence: citation ? { ...evidence, citation } : evidence };
    } catch {
      // One source being down should not fail the whole check.
      return cant("Couldn't reach the data source. Try again in a minute.");
    }
  };

  const checked = await Promise.all(claims.map(checkOne));
  const checkable = checked.filter((c) => c.verdict !== 'cant_check');

  return {
    ticker: postTicker,
    tickers,
    entityName: tickers.length > 1 ? null : checked.find((c) => c.evidence)?.evidence?.entityName ?? postCompany,
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
