import { describeChange, formatDate, formatPercentMagnitude, formatSignedPercent, formatUsd } from '../../format';
import type { Claim, Evidence, EvidenceFigure, GrowthBasis, RevenueEvidence } from '../../types';
import type { Evaluation, EvidenceSource } from '../types';
import { SecClient, filingUrl } from './client';
import { summarizeRevenue } from './revenueFacts';

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

/** Pure comparison: which growth figure does the claim line up with, if any? */
export function evaluateRevenueClaim(claim: Claim, evidence: RevenueEvidence): Evaluation {
  const primaryId = claim.period === 'year' ? 'year_yoy' : 'quarter_yoy';
  const primary = evidence.bases.find((b) => b.id === primaryId) ?? evidence.bases[0];
  if (!primary) return { verdict: 'cant_check', reason: 'The filing data has no comparable periods yet.' };
  if (claim.claimedPercent === null && claim.direction === null) {
    return { verdict: 'cant_check', reason: "The post doesn't say how revenue changed, so there is nothing to compare." };
  }

  const actualText = `Revenue was ${describeChange(primary.percent)} in ${periodWords(primary)} (${formatUsd(
    primary.prior.value,
  )} to ${formatUsd(primary.current.value)}).`;

  const sign = claim.direction === 'down' ? -1 : 1;

  // "Revenue is up" with no number: only the direction can be checked.
  if (claim.claimedPercent === null) {
    const sameDirection = Math.sign(primary.percent) === sign || primary.percent === 0;
    return { verdict: sameDirection ? 'holds_up' : 'contradicted', reason: actualText };
  }

  const claimed = sign * Math.abs(claim.claimedPercent);
  const claimedText = formatPercentMagnitude(claimed);

  if (within(claimed, primary.percent, TIGHT_POINTS, TIGHT_RELATIVE)) {
    return { verdict: 'holds_up', reason: actualText };
  }

  // True of a different comparison than the one a reader would assume.
  const other = evidence.bases.find(
    (b) => b.id !== primary.id && within(claimed, b.percent, TIGHT_POINTS, TIGHT_RELATIVE),
  );
  if (other) {
    return {
      verdict: 'misleading',
      reason: `The ${claimedText} figure matches ${other.label}. ${actualText}`,
    };
  }

  if (within(claimed, primary.percent, LOOSE_POINTS, LOOSE_RELATIVE)) {
    const how = Math.abs(claimed) > Math.abs(primary.percent) ? 'overstated' : 'understated';
    return { verdict: 'misleading', reason: `Close, but ${how}. ${actualText}` };
  }

  return { verdict: 'contradicted', reason: `${actualText} The post says ${claimedText}.` };
}

export interface RevenueSourceOptions {
  sec: SecClient;
}

/** Checks "revenue is up X%" claims against the company's own SEC filings. */
export function createSecRevenueSource({ sec }: RevenueSourceOptions): EvidenceSource {
  return {
    id: 'sec-revenue',
    // A new 10-Q can land any day; six hours keeps results fresh without refetching per check.
    ttlMs: 6 * 60 * 60 * 1000,

    supports: (claim) => claim.type === 'revenue_growth',

    cacheKey: (claim) => `sec-revenue:${claim.ticker ?? ''}`,

    async fetchEvidence(claim): Promise<Evidence | null> {
      if (!claim.ticker) return null;
      const company = await sec.lookupTicker(claim.ticker);
      if (!company) return null;
      const facts = await sec.getCompanyFacts(company.cik);
      if (!facts) return null;
      const summary = summarizeRevenue(facts);
      if (!summary) return null;

      return {
        kind: 'revenue_growth',
        sourceId: 'sec-revenue',
        ticker: claim.ticker,
        entityName: facts.entityName || company.title,
        asOf: summary.latest.periodEnd,
        bases: summary.bases,
        figures: figuresFor(summary.bases),
        citation: {
          label: `Form ${summary.latest.form}, filed ${formatDate(summary.latest.filed)}`,
          url: filingUrl(company.cik, summary.latest.accession),
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
