import { formatDate, formatUsd } from '../../format';
import type { Citation, Claim, Evidence, EvidenceFigure, FigureEvidence, FigureMetric, ReportedPeriod } from '../../types';
import type { Evaluation, EvidenceSource } from '../types';
import { SecClient, filingUrl } from './client';
import { newestFiling, withRelease, type EarningsReleases } from './releases';
import { REVENUE_CONCEPTS } from './revenueFacts';
import { isYear, namedQuarters, notFiledYet, upcomingNamedQuarter, onFileBy, periodWords, quarterAfter, toReported, yearAfter } from './periods';
import { buildSeries } from './series';

// Checks dollar figures a post says a company reported: "Q2 revenue of $11.5B",
// "a $42M net loss". Uses the same SEC data as the revenue growth source.

const CONCEPTS: Record<FigureMetric, string[]> = {
  revenue: REVENUE_CONCEPTS,
  operating_income: ['OperatingIncomeLoss'],
  net_income: ['NetIncomeLoss', 'ProfitLoss'],
};

// Posts round ("$11.5B" for $11.47B), so an exact match is not required.
// Tune these against real posts.
export const TIGHT = 0.03;
export const LOOSE = 0.15;

const within = (claimed: number, actual: number, relative: number) => Math.abs(claimed - actual) <= Math.abs(actual) * relative;

const METRIC_WORDS: Record<FigureMetric, { profit: string; loss: string }> = {
  revenue: { profit: 'revenue', loss: 'revenue' },
  operating_income: { profit: 'operating income', loss: 'an operating loss' },
  net_income: { profit: 'net income', loss: 'a net loss' },
};

function describe(metric: FigureMetric, value: number, bound = ''): string {
  if (metric === 'revenue') return `revenue of ${bound}${formatUsd(value)}`;
  const words = METRIC_WORDS[metric];
  return value < 0 ? `${words.loss} of ${bound}${formatUsd(-value)}` : `${words.profit} of ${bound}${formatUsd(value)}`;
}

export function filingLabel(form: string, filed: string): string {
  return form === '8-K' ? `Form 8-K earnings release, filed ${formatDate(filed)}` : `Form ${form}, filed ${formatDate(filed)}`;
}

function citationFor(evidence: FigureEvidence, p: ReportedPeriod): Citation {
  return {
    label: filingLabel(p.filing.form, p.filing.filed),
    url: p.filing.url ?? filingUrl(evidence.cik, p.filing.accession),
  };
}

function figuresFor(quarters: ReportedPeriod[], years: ReportedPeriod[]): EvidenceFigure[] {
  return [
    ...quarters.slice(0, 4).map((q) => ({
      label: `Quarter ended ${formatDate(q.end)}${q.derived ? ' (calculated)' : q.filing.form === '8-K' ? ' (earnings release)' : ''}`,
      value: formatUsd(q.value),
    })),
    ...years.slice(0, 2).map((y) => ({ label: `Fiscal year ended ${formatDate(y.end)}`, value: formatUsd(y.value) })),
  ];
}

/**
 * Which reported periods could the claim be about?
 *  - targets: the periods the post points at. Matching one means the claim holds up.
 *  - alternates: periods a reader would not assume. Matching one means the claim misleads.
 *  - missing / notFiled: why there is nothing to compare.
 * With a post date, "the latest quarter" is the latest one reported by that day.
 */
function resolvePeriods(
  claim: Claim,
  evidence: FigureEvidence,
): { targets: ReportedPeriod[]; alternates: ReportedPeriod[]; missing?: string; notFiled?: string } {
  const quarters = onFileBy(evidence.quarters, claim.postedAt);
  const years = onFileBy(evidence.years, claim.postedAt);
  const latestQuarter = quarters[0];
  const latestYear = years[0];
  const some = (...periods: Array<ReportedPeriod | undefined>) => periods.filter((p): p is ReportedPeriod => Boolean(p));

  const granularity = claim.fiscalQuarter ? 'quarter' : claim.period ?? (claim.fiscalYear ? 'year' : null);

  if (granularity === 'quarter') {
    if (claim.fiscalQuarter && claim.fiscalYear) {
      const targets = namedQuarters(evidence.quarters, claim.fiscalQuarter, claim.fiscalYear, claim.quote);
      const named = `Q${claim.fiscalQuarter} ${claim.fiscalYear}`;
      if (targets.length === 0) {
        return quarterAfter(evidence.quarters[0], claim.fiscalYear, claim.fiscalQuarter)
          ? { targets, alternates: [], notFiled: named }
          : { targets, alternates: [], missing: named };
      }
      return { targets, alternates: some(latestYear) };
    }
    if (claim.fiscalQuarter) {
      const named = namedQuarters(quarters, claim.fiscalQuarter, null, claim.quote);
      if (named.length) return { targets: named, alternates: some(latestYear) };
    }
    return { targets: some(latestQuarter), alternates: some(latestYear) };
  }

  if (granularity === 'year') {
    if (claim.fiscalYear) {
      const targets = evidence.years.filter((y) => isYear(y, claim.fiscalYear!));
      const named = `fiscal year ${claim.fiscalYear}`;
      if (targets.length === 0) {
        return yearAfter(evidence.years[0], claim.fiscalYear)
          ? { targets, alternates: [], notFiled: named }
          : { targets, alternates: [], missing: named };
      }
      return { targets, alternates: some(latestQuarter) };
    }
    return { targets: some(latestYear), alternates: some(latestQuarter) };
  }

  // The post does not say which period: the latest quarter or the latest year both count.
  return { targets: some(latestQuarter, latestYear), alternates: [] };
}

/** Pure comparison of a claimed dollar figure with what the company filed. */
export function evaluateFigureClaim(claim: Claim, evidence: FigureEvidence): Evaluation {
  const claimed = claim.claimedAmount;
  if (claimed === null) return { verdict: 'cant_check', reason: "The post doesn't give a dollar amount to compare." };

  if (/\b(?:non[- ]?gaap|adjusted|adj\.?|ex[- ]items|excluding)\b/i.test(claim.quote)) {
    return { verdict: 'cant_check', reason: 'This is an adjusted (non-GAAP) figure. SEC filings report the standard GAAP figure, which leaves nothing like-for-like to compare.' };
  }
  const { targets, alternates, missing, notFiled } = resolvePeriods(claim, evidence);
  if (notFiled) return { verdict: 'cant_check', reason: notFiledYet(notFiled, evidence.quarters[0] ?? evidence.years[0], evidence.ticker) };
  if (targets.length === 0) {
    const newest = evidence.quarters[0] ?? evidence.years[0];
    const tail = newest ? ` The most recent period on file is ${periodWords(newest)}.` : '';
    return {
      verdict: 'cant_check',
      reason: missing ? `SEC data for ${evidence.ticker} doesn't include ${missing}.${tail}` : `No reported figures found for ${evidence.ticker}.`,
    };
  }

  const reported = (p: ReportedPeriod) => `${describe(evidence.metric, p.value)} for ${periodWords(p)}`;
  const calculated = (p: ReportedPeriod) => (p.derived ? ' That quarter is calculated as the full year minus the first three quarters.' : '');
  const b = claim.bound === 'at_least' ? 'more than ' : claim.bound === 'at_most' ? 'less than ' : '';
  const claimedText = describe(evidence.metric, claimed, b);

  // "Over $2 billion": a floor or ceiling. Compare magnitudes of the same sign.
  if (claim.bound) {
    const meets = (p: ReportedPeriod) =>
      Math.sign(p.value) === Math.sign(claimed) &&
      (claim.bound === 'at_least' ? Math.abs(p.value) >= Math.abs(claimed) * (1 - TIGHT) : Math.abs(p.value) <= Math.abs(claimed) * (1 + TIGHT));
    const ok = targets.find(meets);
    if (ok) return { verdict: 'holds_up', reason: `The company reported ${describe(evidence.metric, ok.value)} for ${periodWords(ok)}.`, citation: citationFor(evidence, ok) };
    const p = targets[0]!;
    return {
      verdict: 'contradicted',
      reason: `The company reported ${describe(evidence.metric, p.value)} for ${periodWords(p)}. The post says ${claimedText}.`,
      citation: citationFor(evidence, p),
    };
  }

  const hit = targets.find((p) => within(claimed, p.value, TIGHT));
  if (hit) {
    return { verdict: 'holds_up', reason: `The company reported ${reported(hit)}.${calculated(hit)}`, citation: citationFor(evidence, hit) };
  }

  // The closest of the periods the post could mean is the one to show.
  const nearest = [...targets].sort((a, b) => Math.abs(claimed - a.value) - Math.abs(claimed - b.value))[0]!;
  const actual = `The company reported ${targets.map(reported).join(' and ')}.${calculated(nearest)}`;
  const citation = citationFor(evidence, nearest);

  const other = alternates.find((p) => within(claimed, p.value, TIGHT));
  if (other) {
    const expected = nearest.kind === 'quarter' ? 'a single quarter' : 'the full year';
    return { verdict: 'misleading', reason: `That figure matches ${periodWords(other)}, not ${expected}. ${actual}`, citation };
  }

  const sameSign = Math.sign(claimed) === Math.sign(nearest.value);
  if (sameSign && within(claimed, nearest.value, LOOSE)) {
    const how = Math.abs(claimed) > Math.abs(nearest.value) ? 'overstated' : 'understated';
    return { verdict: 'misleading', reason: `Close, but ${how}. ${actual}`, citation };
  }

  const upcoming = claim.fiscalQuarter && !claim.fiscalYear ? upcomingNamedQuarter(onFileBy(evidence.quarters, claim.postedAt), claim.fiscalQuarter) : null;
  if (upcoming) {
    return { verdict: 'cant_check', reason: `${notFiledYet(upcoming, evidence.quarters[0], evidence.ticker)} The post is likely about ${upcoming}, not the Q${claim.fiscalQuarter} a year earlier.` };
  }

  // No period and no post date: "the latest" is only a guess. A figure that
  // matches an earlier period is more likely an older post than a false one.
  if (!claim.postedAt && !claim.fiscalQuarter && !claim.fiscalYear) {
    const older = [...evidence.quarters.slice(1, 13), ...evidence.years.slice(1, 4)].find((p) => within(claimed, p.value, TIGHT));
    if (older) {
      return {
        verdict: 'cant_check',
        reason: `The company reported ${reported(older)}, which matches. The post has no date, so it may be about that period. Add the post's date to check it against the latest figures at the time.`,
        citation: citationFor(evidence, older),
      };
    }
  }

  return { verdict: 'contradicted', reason: `${actual} The post says ${claimedText}.`, citation };
}

export interface FigureSourceOptions {
  sec: SecClient;
  /** Optional: fresher quarters from earnings press releases, before the 10-Q is filed. */
  releases?: EarningsReleases;
}

export function createSecFigureSource({ sec, releases }: FigureSourceOptions): EvidenceSource {
  const metricOf = (claim: Claim): FigureMetric | null =>
    claim.metric === 'revenue' || claim.metric === 'net_income' || claim.metric === 'operating_income' ? claim.metric : null;

  return {
    id: 'sec-figure',
    ttlMs: 6 * 60 * 60 * 1000,

    // A business line ("Azure revenue") is never checked against the company total.
    supports: (claim) => claim.type === 'financial_figure' && !claim.segment && metricOf(claim) !== null && claim.claimedAmount !== null,

    cacheKey: (claim) => `sec-figure:${claim.ticker ?? ''}:${claim.metric ?? ''}`,

    async fetchEvidence(claim): Promise<Evidence | null> {
      const metric = metricOf(claim);
      if (!claim.ticker || !metric) return null;
      const company = await sec.lookupTicker(claim.ticker);
      if (!company) return null;
      const facts = await sec.getCompanyFacts(company.cik);
      if (!facts) return null;
      let series = buildSeries(facts, CONCEPTS[metric], { preferLargest: metric === 'revenue' });
      if (!series) return null;
      if (releases) series = withRelease(series, await releases.latest(company.cik, newestFiling(series)), metric);

      const quarters = series.quarters.slice(0, 12).map(toReported);
      const years = series.years.slice(0, 6).map(toReported);
      const newest = [quarters[0], years[0]].filter((p): p is ReportedPeriod => Boolean(p)).sort((a, b) => (a.end < b.end ? 1 : -1))[0];
      if (!newest) return null;

      const evidence: FigureEvidence = {
        kind: 'financial_figure',
        sourceId: 'sec-figure',
        ticker: claim.ticker,
        entityName: facts.entityName || company.title,
        asOf: newest.end,
        metric,
        cik: company.cik,
        quarters,
        years,
        figures: figuresFor(quarters, years),
        citation: { label: '', url: '' },
      };
      evidence.citation = citationFor(evidence, newest);
      return evidence;
    },

    evaluate(claim, evidence) {
      if (evidence.kind !== 'financial_figure') {
        return { verdict: 'cant_check', reason: 'The data found does not match this claim.' };
      }
      return evaluateFigureClaim(claim, evidence);
    },
  };
}
