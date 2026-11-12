import { describeChange, formatDate, formatPercentMagnitude, formatSignedPercent, formatUsd } from '../../format';
import type { Claim, Evidence, EvidenceFigure, GrowthBasis, ReportedPeriod, RevenueEvidence } from '../../types';
import type { Evaluation, EvidenceSource } from '../types';
import { SecClient, filingUrl } from './client';
import { filingLabel } from './figureSource';
import { newestFiling, type EarningsReleases } from './releases';
import { isQuarter, isYear, latestNamedQuarter, notFiledYet, onFileBy, periodWords as reportedWords, quarterAfter, yearAfter } from './periods';
import { REVENUE_CONCEPTS, growthBases, summarizeRevenue } from './revenueFacts';
import { buildSeries } from './series';

// How close a claimed percentage must be to the filed one. Tune these against
// real posts: tight = "holds up", loose = "close but overstated or understated".
export const TIGHT_POINTS = 2;
export const TIGHT_RELATIVE = 0.1;
export const LOOSE_POINTS = 5;
export const LOOSE_RELATIVE = 0.25;

function within(claimed: number, actual: number, points: number, relative: number): boolean {
  return Math.abs(claimed - actual) <= Math.max(points, Math.abs(actual) * relative);
}

function periodWords(basis: GrowthBasis): string {
  const end = formatDate(basis.current.end);
  switch (basis.id) {
    case 'quarter_yoy':
      return `the quarter ended ${end}, compared with a year earlier`;
    case 'quarter_qoq':
      return `the quarter ended ${end}, compared with the quarter before`;
    case 'year_yoy':
      return `the fiscal year ended ${end}, compared with the year before`;
  }
}

function figuresFor(bases: GrowthBasis[]): EvidenceFigure[] {
  const rows: EvidenceFigure[] = [];
  for (const b of bases) {
    const unit = b.id === 'year_yoy' ? 'Fiscal year' : 'Quarter';
    const priorLabel = b.id === 'quarter_qoq' ? 'Quarter before, ended' : `${unit} ended`;
    if (b.id !== 'quarter_qoq') {
      rows.push({ label: `${unit} ended ${formatDate(b.current.end)}`, value: formatUsd(b.current.value) });
    }
    rows.push({ label: `${priorLabel} ${formatDate(b.prior.end)}`, value: formatUsd(b.prior.value) });
    const changeLabel =
      b.id === 'quarter_yoy' ? 'Change, year over year' : b.id === 'quarter_qoq' ? 'Change, quarter over quarter' : 'Change, full year';
    rows.push({ label: changeLabel, value: formatSignedPercent(b.percent) });
  }
  return rows;
}

/**
 * The quarter and year the claim is about, and why there may be none.
 * With a post date, "the latest" means the latest reported by that day.
 */
function referencePeriods(claim: Claim, evidence: RevenueEvidence): { q?: ReportedPeriod; y?: ReportedPeriod; named: boolean; stop?: string } {
  const all = { quarters: evidence.quarters ?? [], years: evidence.years ?? [] };
  const quarters = onFileBy(all.quarters, claim.postedAt);
  const years = onFileBy(all.years, claim.postedAt);
  const missing = (named: string, newer: boolean) => {
    if (newer) return notFiledYet(named, all.quarters[0] ?? all.years[0], evidence.ticker);
    const newest = all.quarters[0] ?? all.years[0];
    return `SEC data for ${evidence.ticker} doesn't include ${named}.${newest ? ` The most recent period on file is ${reportedWords(newest)}.` : ''}`;
  };

  if (claim.fiscalQuarter && claim.fiscalYear) {
    const q = all.quarters.find((p) => isQuarter(p, claim.fiscalYear!, claim.fiscalQuarter!));
    if (!q) return { named: true, stop: missing(`Q${claim.fiscalQuarter} ${claim.fiscalYear}`, quarterAfter(all.quarters[0], claim.fiscalYear, claim.fiscalQuarter)) };
    return { q, y: years.find((p) => p.end <= q.end), named: true };
  }
  if (claim.fiscalQuarter) {
    const q = latestNamedQuarter(quarters, claim.fiscalQuarter);
    if (q) return { q, y: years.find((p) => p.end <= q.end), named: true };
  }
  if (claim.fiscalYear && claim.period !== 'quarter') {
    const y = all.years.find((p) => isYear(p, claim.fiscalYear!));
    if (!y) return { named: true, stop: missing(`fiscal year ${claim.fiscalYear}`, yearAfter(all.years[0], claim.fiscalYear)) };
    return { y, named: true };
  }
  return { q: quarters[0], y: years[0], named: Boolean(claim.postedAt) };
}

/**
 * The comparisons the claim names. "YoY" with no period may be the quarter
 * or the year; "QoQ" is always quarter over quarter.
 */
function namedBases(claim: Claim): GrowthBasis['id'][] {
  const quarterly = claim.period === 'quarter' || claim.fiscalQuarter !== null;
  const yearly = !quarterly && (claim.period === 'year' || claim.fiscalYear !== null);
  if (claim.comparison === 'qoq') return ['quarter_qoq'];
  if (claim.comparison === 'yoy') return quarterly ? ['quarter_yoy'] : yearly ? ['year_yoy'] : ['quarter_yoy', 'year_yoy'];
  return yearly ? ['year_yoy'] : ['quarter_yoy'];
}

/** Pure comparison: which growth figure does the claim line up with, if any? */
export function evaluateRevenueClaim(claim: Claim, evidence: RevenueEvidence): Evaluation {
  if (claim.claimedPercent === null && claim.direction === null) {
    return { verdict: 'cant_check', reason: "The post doesn't say how revenue changed, so there is nothing to compare." };
  }

  // Older cached evidence has only the latest bases.
  let bases = evidence.bases;
  if (evidence.quarters?.length || evidence.years?.length) {
    const ref = referencePeriods(claim, evidence);
    if (ref.stop) return { verdict: 'cant_check', reason: ref.stop };
    bases = growthBases(evidence.quarters, evidence.years, ref.q, ref.y, ref.named ? 'named' : 'latest');
  }

  const wanted = namedBases(claim);
  const targets = wanted.map((id) => bases.find((b) => b.id === id)).filter((b): b is GrowthBasis => Boolean(b));
  const primary = targets[0];
  if (!primary) {
    const what = wanted[0] === 'quarter_qoq' ? 'the quarter before' : 'a year earlier';
    return { verdict: 'cant_check', reason: `The filing data has no figure from ${what} to compare with.` };
  }
  const alternates = bases.filter((b) => !targets.includes(b));

  const actualText = (b: GrowthBasis) =>
    `Revenue was ${describeChange(b.percent)} in ${periodWords(b)} (${formatUsd(b.prior.value)} to ${formatUsd(b.current.value)}).`;
  const sign = claim.direction === 'down' ? -1 : 1;

  // "Revenue is up" with no number: only the direction can be checked.
  if (claim.claimedPercent === null) {
    const same = (b: GrowthBasis) => Math.sign(b.percent) === sign || b.percent === 0;
    const hit = targets.find(same);
    return hit ? { verdict: 'holds_up', reason: actualText(hit) } : { verdict: 'contradicted', reason: actualText(primary) };
  }

  const claimed = sign * Math.abs(claim.claimedPercent);
  const claimedText = `${claim.bound === 'at_least' ? 'more than ' : claim.bound === 'at_most' ? 'less than ' : ''}${formatPercentMagnitude(claimed)}`;

  // "More than doubled": a floor, not a figure. Compare in the claimed direction.
  if (claim.bound) {
    const tol = Math.max(TIGHT_POINTS, Math.abs(claimed) * TIGHT_RELATIVE);
    const meets = (b: GrowthBasis) => {
      const actual = sign * b.percent;
      return claim.bound === 'at_least' ? actual >= Math.abs(claimed) - tol : actual <= Math.abs(claimed) + tol;
    };
    const ok = targets.find(meets);
    if (ok) return { verdict: 'holds_up', reason: actualText(ok) };
    if (within(claimed, primary.percent, LOOSE_POINTS, LOOSE_RELATIVE)) {
      return { verdict: 'misleading', reason: `Close, but short of what the post says (${claimedText}). ${actualText(primary)}` };
    }
    return { verdict: 'contradicted', reason: `${actualText(primary)} The post says ${claimedText}.` };
  }

  // The claim matches the comparison it names: that settles it.
  const hit = targets.find((b) => within(claimed, b.percent, TIGHT_POINTS, TIGHT_RELATIVE));
  if (hit) return { verdict: 'holds_up', reason: actualText(hit) };

  // True of a different comparison than the one the post names or a reader would assume.
  const other = alternates.find((b) => within(claimed, b.percent, TIGHT_POINTS, TIGHT_RELATIVE));
  if (other) {
    return { verdict: 'misleading', reason: `The ${claimedText} figure matches ${other.label}. ${actualText(primary)}` };
  }

  if (within(claimed, primary.percent, LOOSE_POINTS, LOOSE_RELATIVE)) {
    const how = Math.abs(claimed) > Math.abs(primary.percent) ? 'overstated' : 'understated';
    return { verdict: 'misleading', reason: `Close, but ${how}. ${actualText(primary)}` };
  }

  return { verdict: 'contradicted', reason: `${actualText(primary)} The post says ${claimedText}.` };
}

export interface RevenueSourceOptions {
  sec: SecClient;
  /** Optional: fresher quarters from earnings press releases, before the 10-Q is filed. */
  releases?: EarningsReleases;
}

/** Checks "revenue is up X%" claims against the company's own SEC filings. */
export function createSecRevenueSource({ sec, releases }: RevenueSourceOptions): EvidenceSource {
  return {
    id: 'sec-revenue',
    // A new 10-Q can land any day; six hours keeps results fresh without refetching per check.
    ttlMs: 6 * 60 * 60 * 1000,

    // A business line ("Azure grew 40%") is never checked against total revenue.
    supports: (claim) => claim.type === 'revenue_growth' && !claim.segment,

    cacheKey: (claim) => `sec-revenue:${claim.ticker ?? ''}`,

    async fetchEvidence(claim): Promise<Evidence | null> {
      if (!claim.ticker) return null;
      const company = await sec.lookupTicker(claim.ticker);
      if (!company) return null;
      const facts = await sec.getCompanyFacts(company.cik);
      if (!facts) return null;
      let release = null;
      if (releases) {
        const filed = buildSeries(facts, REVENUE_CONCEPTS, { preferLargest: true });
        if (filed) release = await releases.latest(company.cik, newestFiling(filed));
      }
      const summary = summarizeRevenue(facts, release);
      if (!summary) return null;

      return {
        kind: 'revenue_growth',
        sourceId: 'sec-revenue',
        ticker: claim.ticker,
        entityName: facts.entityName || company.title,
        asOf: summary.latest.periodEnd,
        bases: summary.bases,
        quarters: summary.quarters,
        years: summary.years,
        figures: figuresFor(summary.bases),
        citation: {
          label: filingLabel(summary.latest.form, summary.latest.filed),
          url: summary.latest.url ?? filingUrl(company.cik, summary.latest.accession),
        },
      };
    },

    evaluate(claim, evidence) {
      if (evidence.kind !== 'revenue_growth') {
        return { verdict: 'cant_check', reason: 'The data found does not match this claim.' };
      }
      return evaluateRevenueClaim(claim, evidence);
    },
  };
}
