import type { GrowthBasis, PeriodValue } from '../../types';
import type { SecCompanyFacts } from './client';
import { DAY, buildSeries, endingNear, toTime, type SeriesPeriod } from './series';

// Companies tag revenue under different names. The one with the newest data wins.
export const REVENUE_CONCEPTS = [
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'Revenues',
  'SalesRevenueNet',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
];

export interface RevenueSummary {
  concept: string;
  bases: GrowthBasis[];
  /** The filing that reported the most recent period. */
  latest: { accession: string; form: string; filed: string; periodEnd: string };
}

function basis(id: GrowthBasis['id'], label: string, current: SeriesPeriod, prior: SeriesPeriod): GrowthBasis | null {
  if (prior.value <= 0) return null;
  const pv = (p: SeriesPeriod): PeriodValue => ({ start: p.start, end: p.end, value: p.value });
  return { id, label, current: pv(current), prior: pv(prior), percent: ((current.value - prior.value) / prior.value) * 100 };
}

/**
 * Turn the SEC's raw facts into the growth figures a post is likely to quote:
 * latest quarter vs a year earlier, latest quarter vs the previous quarter,
 * and latest fiscal year vs the one before.
 */
export function summarizeRevenue(facts: SecCompanyFacts): RevenueSummary | null {
  const series = buildSeries(facts, REVENUE_CONCEPTS);
  if (!series) return null;

  const { quarters, years } = series;
  const bases: GrowthBasis[] = [];

  const q = quarters[0];
  if (q) {
    const yearAgo = endingNear(quarters, toTime(q.end) - 365 * DAY);
    if (yearAgo) {
      const b = basis('quarter_yoy', 'the latest quarter vs the same quarter a year earlier', q, yearAgo);
      if (b) bases.push(b);
    }
    const previous = endingNear(quarters, toTime(q.start) - DAY);
    if (previous && previous !== q) {
      const b = basis('quarter_qoq', 'the latest quarter vs the quarter before it', q, previous);
      if (b) bases.push(b);
    }
  }

  const y = years[0];
  if (y) {
    const priorYear = endingNear(years, toTime(y.end) - 365 * DAY);
    if (priorYear) {
      const b = basis('year_yoy', 'the latest full fiscal year vs the year before', y, priorYear);
      if (b) bases.push(b);
    }
  }

  if (bases.length === 0) return null;

  // Whichever was reported most recently: the latest quarter or the latest year.
  const newest = [q, y].filter((p): p is SeriesPeriod => Boolean(p)).sort((a, b) => (a.end < b.end ? 1 : -1))[0]!;
  return {
    concept: series.concept,
    bases,
    latest: { accession: newest.accession, form: newest.form, filed: newest.filed, periodEnd: newest.end },
  };
}
