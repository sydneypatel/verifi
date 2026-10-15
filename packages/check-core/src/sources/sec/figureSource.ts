import { formatDate, formatUsd } from '../../format';
import type { Citation, Claim, Evidence, EvidenceFigure, FigureEvidence, ReportedPeriod } from '../../types';
import type { Evaluation, EvidenceSource } from '../types';
import { SecClient, filingUrl } from './client';
import { REVENUE_CONCEPTS } from './revenueFacts';
import { buildSeries, toTime, type SeriesPeriod } from './series';

// Checks dollar figures a post says a company reported: "Q2 revenue of $11.5B",
// "a $42M net loss". Uses the same SEC data as the revenue growth source.

const CONCEPTS: Record<FigureEvidence['metric'], string[]> = {
  revenue: REVENUE_CONCEPTS,
  net_income: ['NetIncomeLoss', 'ProfitLoss'],
};

// Posts round ("$11.5B" for $11.47B), so an exact match is not required.
// Tune these against real posts.
export const TIGHT = 0.03;
export const LOOSE = 0.15;

const within = (claimed: number, actual: number, relative: number) => Math.abs(claimed - actual) <= Math.abs(actual) * relative;

function describe(metric: FigureEvidence['metric'], value: number): string {
  if (metric === 'revenue') return `revenue of ${formatUsd(value)}`;
  return value < 0 ? `a net loss of ${formatUsd(-value)}` : `net income of ${formatUsd(value)}`;
}

function periodWords(p: ReportedPeriod): string {
  if (p.kind === 'year') return `the fiscal year ended ${formatDate(p.end)}`;
  const label = p.fiscalQuarter && p.fiscalYear ? ` (fiscal Q${p.fiscalQuarter} ${p.fiscalYear})` : '';
  return `the quarter ended ${formatDate(p.end)}${label}`;
}

/** The calendar quarter a period mostly falls in, for posts that use calendar labels. */
function calendarOf(p: ReportedPeriod): { year: number; quarter: number } {
  const middle = new Date((toTime(p.start) + toTime(p.end)) / 2);
  return { year: middle.getUTCFullYear(), quarter: Math.floor(middle.getUTCMonth() / 3) + 1 };
}

function citationFor(evidence: FigureEvidence, p: ReportedPeriod): Citation {
  return {
    label: `Form ${p.filing.form}, filed ${formatDate(p.filing.filed)}`,
    url: filingUrl(evidence.cik, p.filing.accession),
  };
}

function toReported(p: SeriesPeriod): ReportedPeriod {
  return {
    kind: p.kind,
    start: p.start,
    end: p.end,
    value: p.value,
    fiscalYear: p.fiscalYear,
    fiscalQuarter: p.fiscalQuarter,
    derived: p.derived,
    filing: { accession: p.accession, form: p.form, filed: p.filed },
  };
}

function figuresFor(quarters: ReportedPeriod[], years: ReportedPeriod[]): EvidenceFigure[] {
  return [
    ...quarters.slice(0, 4).map((q) => ({
      label: `Quarter ended ${formatDate(q.end)}${q.derived ? ' (calculated)' : ''}`,
      value: formatUsd(q.value),
    })),
    ...years.slice(0, 2).map((y) => ({ label: `Fiscal year ended ${formatDate(y.end)}`, value: formatUsd(y.value) })),
  ];
}

/**
 * Which reported periods could the claim be about?
 *  - targets: the periods the post points at. Matching one means the claim holds up.
 *  - alternates: periods a reader would not assume. Matching one means the claim misleads.
 */
function resolvePeriods(claim: Claim, evidence: FigureEvidence): { targets: ReportedPeriod[]; alternates: ReportedPeriod[]; missing?: string } {
  const latestQuarter = evidence.quarters[0];
  const latestYear = evidence.years[0];
  const some = (...periods: Array<ReportedPeriod | undefined>) => periods.filter((p): p is ReportedPeriod => Boolean(p));

  const granularity = claim.fiscalQuarter ? 'quarter' : claim.period ?? (claim.fiscalYear ? 'year' : null);

  if (granularity === 'quarter') {
    if (claim.fiscalQuarter && claim.fiscalYear) {
      // "Q2 2026" may be the company's fiscal label or the calendar quarter. Accept either.
      const targets = evidence.quarters.filter((q) => {
        const calendar = calendarOf(q);
        return (
          (q.fiscalYear === claim.fiscalYear && q.fiscalQuarter === claim.fiscalQuarter) ||
          (calendar.year === claim.fiscalYear && calendar.quarter === claim.fiscalQuarter)
        );
      });
      if (targets.length === 0) return { targets, alternates: [], missing: `Q${claim.fiscalQuarter} ${claim.fiscalYear}` };
      return { targets, alternates: some(latestYear) };
    }
    if (claim.fiscalQuarter) {
      // "Q2 revenue" with no year: the most recent quarter with that label,
      // by the company's fiscal calendar or the calendar year.
      const named = evidence.quarters.find((q) => q.fiscalQuarter === claim.fiscalQuarter || calendarOf(q).quarter === claim.fiscalQuarter);
      if (named) return { targets: some(named), alternates: some(latestYear) };
    }
    return { targets: some(latestQuarter), alternates: some(latestYear) };
  }

  if (granularity === 'year') {
    if (claim.fiscalYear) {
      const targets = evidence.years.filter((y) => y.fiscalYear === claim.fiscalYear || Number(y.end.slice(0, 4)) === claim.fiscalYear);
      if (targets.length === 0) return { targets, alternates: [], missing: `fiscal year ${claim.fiscalYear}` };
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

  const { targets, alternates, missing } = resolvePeriods(claim, evidence);
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
  const claimedText =
    evidence.metric === 'revenue'
      ? `revenue of ${b}${formatUsd(claimed)}`
      : claimed < 0
        ? `a net loss of ${b}${formatUsd(-claimed)}`
        : `net income of ${b}${formatUsd(claimed)}`;

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

  return { verdict: 'contradicted', reason: `${actual} The post says ${claimedText}.`, citation };
}

export function createSecFigureSource({ sec }: { sec: SecClient }): EvidenceSource {
  const metricOf = (claim: Claim) => (claim.metric === 'revenue' || claim.metric === 'net_income' ? claim.metric : null);

  return {
    id: 'sec-figure',
    ttlMs: 6 * 60 * 60 * 1000,

    supports: (claim) => claim.type === 'financial_figure' && metricOf(claim) !== null && claim.claimedAmount !== null,

    cacheKey: (claim) => `sec-figure:${claim.ticker ?? ''}:${claim.metric ?? ''}`,

    async fetchEvidence(claim): Promise<Evidence | null> {
      const metric = metricOf(claim);
      if (!claim.ticker || !metric) return null;
      const company = await sec.lookupTicker(claim.ticker);
      if (!company) return null;
      const facts = await sec.getCompanyFacts(company.cik);
      if (!facts) return null;
      const series = buildSeries(facts, CONCEPTS[metric]);
      if (!series) return null;

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
