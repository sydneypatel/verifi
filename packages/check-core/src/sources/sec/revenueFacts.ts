import type { GrowthBasis, PeriodValue, ReportedPeriod } from '../../types';
import { toReported } from './periods';
import type { SecCompanyFacts } from './client';
import { withRelease, type EarningsRelease } from './releases';
import { DAY, buildSeries, endingNear, toTime, type SeriesPeriod } from './series';

// Companies tag revenue under different names. The one with the newest data wins.
export const REVENUE_CONCEPTS = [
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'Revenues',
  'SalesRevenueNet',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
];

function basis(id: GrowthBasis['id'], label: string, current: PeriodValue, prior: PeriodValue): GrowthBasis | null {
  if (prior.value <= 0) return null;
  const pv = (p: PeriodValue): PeriodValue => ({ start: p.start, end: p.end, value: p.value });
  return { id, label, current: pv(current), prior: pv(prior), percent: ((current.value - prior.value) / prior.value) * 100 };
}

const LABELS: Record<GrowthBasis['id'], { latest: string; named: string }> = {
  quarter_yoy: { latest: 'the latest quarter vs the same quarter a year earlier', named: 'that quarter vs the same quarter a year earlier' },
  quarter_qoq: { latest: 'the latest quarter vs the quarter before it', named: 'that quarter vs the quarter before it' },
  year_yoy: { latest: 'the latest full fiscal year vs the year before', named: 'that fiscal year vs the year before' },
};

/**
 * Growth for one quarter and one fiscal year: the quarter vs a year earlier,
 * the quarter vs the one before, and the year vs the year before. Prior
 * periods are looked up in the full lists, newest first.
 */
export function growthBases<T extends PeriodValue>(
  quarters: T[],
  years: T[],
  q: T | undefined,
  y: T | undefined,
  wording: 'latest' | 'named' = 'latest',
): GrowthBasis[] {
  const bases: GrowthBasis[] = [];
  const add = (b: GrowthBasis | null) => b && bases.push(b);
  if (q) {
    const yearAgo = endingNear(quarters, toTime(q.end) - 365 * DAY);
    if (yearAgo) add(basis('quarter_yoy', LABELS.quarter_yoy[wording], q, yearAgo));
    const previous = endingNear(quarters, toTime(q.start) - DAY);
    if (previous && previous !== q) add(basis('quarter_qoq', LABELS.quarter_qoq[wording], q, previous));
  }
  if (y) {
    const priorYear = endingNear(years, toTime(y.end) - 365 * DAY);
    if (priorYear) add(basis('year_yoy', LABELS.year_yoy[wording], y, priorYear));
  }
  return bases;
}

export interface RevenueSummary {
  concept: string;
  bases: GrowthBasis[];
  /** Every quarter and year on file, newest first. */
  quarters: ReportedPeriod[];
  years: ReportedPeriod[];
  /** The filing that reported the most recent period. */
  latest: { accession: string; form: string; filed: string; periodEnd: string; url?: string };
}

/**
 * Turn the SEC's raw facts into the growth figures a post is likely to quote:
 * latest quarter vs a year earlier, latest quarter vs the previous quarter,
 * and latest fiscal year vs the one before.
 */
export function summarizeRevenue(facts: SecCompanyFacts, release?: EarningsRelease | null): RevenueSummary | null {
  // The total, when a company tags both total and partial revenue (Vistra).
  const filed = buildSeries(facts, REVENUE_CONCEPTS, { preferLargest: true });
  if (!filed) return null;
  // A newer quarter from an earnings press release, if there is one.
  const series = withRelease(filed, release, 'revenue');

  const { quarters, years } = series;
  const q = quarters[0];
  const y = years[0];
  const bases = growthBases(quarters, years, q, y);
  if (bases.length === 0) return null;

  // Whichever was reported most recently: the latest quarter or the latest year.
  const newest = [q, y].filter((p): p is SeriesPeriod => Boolean(p)).sort((a, b) => (a.end < b.end ? 1 : -1))[0]!;
  return {
    concept: series.concept,
    bases,
    quarters: quarters.slice(0, 16).map(toReported),
    years: years.slice(0, 6).map(toReported),
    latest: { accession: newest.accession, form: newest.form, filed: newest.filed, periodEnd: newest.end, ...(newest.url ? { url: newest.url } : {}) },
  };
}
