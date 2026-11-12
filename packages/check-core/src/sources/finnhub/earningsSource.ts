import { formatDate, formatPercentMagnitude, formatPerShare } from '../../format';
import type { Claim, EarningsEvidence, EarningsQuarter, Evidence, EvidenceFigure, Quarter, Verdict } from '../../types';
import type { Evaluation, EvidenceSource } from '../types';
import type { FinnhubClient } from './client';

// Checks "beat earnings", "missed estimates" and "EPS of $1.25" against the
// reported EPS and the analyst estimate before it (Finnhub, last four quarters).

/** A beat or miss smaller than half a cent is "in line". */
export const IN_LINE = 0.005;
/** EPS posts round to the cent. */
export const EPS_TIGHT_DOLLARS = 0.01;
export const EPS_TIGHT_RELATIVE = 0.03;
export const EPS_LOOSE_RELATIVE = 0.15;
/** "Beat by 20%": the stated surprise. */
export const SURPRISE_TIGHT_POINTS = 2;
export const SURPRISE_TIGHT_RELATIVE = 0.2;

const BASIS_NOTE = ' Estimates and reported EPS here are on the adjusted basis analysts use, which can differ from the GAAP figure in the filing.';

type Outcome = 'beat' | 'miss' | 'in_line';

function outcomeOf(q: EarningsQuarter): Outcome | null {
  if (q.actual === null || q.estimate === null) return null;
  const diff = q.actual - q.estimate;
  return Math.abs(diff) < IN_LINE ? 'in_line' : diff > 0 ? 'beat' : 'miss';
}

// Finnhub's `period` is the calendar quarter it files a report under, not the
// company's real quarter end (NVIDIA's fiscal Q2 ends in late July but is dated
// Sep 30). So the fiscal label is shown when there is one, and the date only
// when there is not.
function quarterWords(q: EarningsQuarter): string {
  return q.fiscalQuarter && q.fiscalYear ? `fiscal Q${q.fiscalQuarter} ${q.fiscalYear}` : `the quarter ended ${formatDate(q.period)}`;
}

function quarterLabel(q: EarningsQuarter): string {
  return q.fiscalQuarter && q.fiscalYear ? `Fiscal Q${q.fiscalQuarter} ${q.fiscalYear}` : `Quarter ended ${formatDate(q.period)}`;
}

function factsText(q: EarningsQuarter): string {
  if (q.actual === null) return `No reported EPS for ${quarterWords(q)} yet.`;
  if (q.estimate === null) return `For ${quarterWords(q)}, EPS was ${formatPerShare(q.actual)}. No analyst estimate is on record.`;
  const outcome = outcomeOf(q)!;
  const surprise = q.surprisePercent !== null && outcome !== 'in_line' ? `, a ${outcome} of ${formatPercentMagnitude(q.surprisePercent)}` : outcome === 'in_line' ? ', in line' : '';
  return `For ${quarterWords(q)}, EPS was ${formatPerShare(q.actual)} against an analyst estimate of ${formatPerShare(q.estimate)}${surprise}.`;
}

/** The quarter the claim is about: the one it names, or the latest reported (by the post's date, when known). */
function targetOf(claim: Claim, quarters: EarningsQuarter[]): EarningsQuarter | undefined {
  const reported = quarters.filter((q) => q.actual !== null);
  if (!claim.fiscalQuarter) return claim.postedAt ? reported.find((q) => q.period < claim.postedAt!) : reported[0];
  // The company's own label first; the calendar quarter only as a fallback.
  const fiscal = reported.find((q) => q.fiscalQuarter === claim.fiscalQuarter && (!claim.fiscalYear || q.fiscalYear === claim.fiscalYear));
  if (fiscal) return fiscal;
  return reported.find((q) => {
    const quarter = Math.ceil(Number(q.period.slice(5, 7)) / 3);
    return quarter === claim.fiscalQuarter && (!claim.fiscalYear || Number(q.period.slice(0, 4)) === claim.fiscalYear);
  });
}

const RANK: Record<Verdict, number> = { contradicted: 3, misleading: 2, holds_up: 1, cant_check: 0 };

/** True when "Q{quarter} {year}" comes after every quarter on record, by fiscal or calendar label. */
function afterNewest(claim: Claim, quarters: EarningsQuarter[]): boolean {
  if (!claim.fiscalQuarter || !claim.fiscalYear) return false;
  const reported = quarters.filter((q) => q.actual !== null);
  const newest = reported[0];
  if (!newest) return false;
  const named = claim.fiscalYear * 4 + claim.fiscalQuarter;
  const calendar = Number(newest.period.slice(0, 4)) * 4 + Math.ceil(Number(newest.period.slice(5, 7)) / 3);
  const fiscal = newest.fiscalYear && newest.fiscalQuarter ? newest.fiscalYear * 4 + newest.fiscalQuarter : null;
  // With fiscal labels, only when it is later by both readings: "Q1 2027" can be a fiscal label already on record.
  return fiscal !== null ? named > calendar && named > fiscal : named > calendar;
}

/** Pure comparison of an earnings claim with reported EPS and estimates. */
export function evaluateEarningsClaim(claim: Claim, evidence: EarningsEvidence): Evaluation {
  // "EPS up 40% YoY" is growth. A beat against estimates says nothing about it.
  if (claim.vsEstimate === null && claim.claimedAmount === null && claim.claimedPercent !== null) {
    return { verdict: 'cant_check', reason: "This is about EPS growth, not a beat or miss. Verifi checks EPS against analyst estimates, and doesn't check EPS growth yet." };
  }
  if (claim.vsEstimate === null && claim.claimedAmount === null) {
    return { verdict: 'cant_check', reason: "The post doesn't say how earnings compared with estimates or give a per-share figure." };
  }
  if (afterNewest(claim, evidence.quarters)) {
    const newest = evidence.quarters.find((q) => q.actual !== null)!;
    return {
      verdict: 'cant_check',
      reason: `Q${claim.fiscalQuarter} ${claim.fiscalYear} isn't reported yet, so ${evidence.ticker}'s EPS for it can't be checked. The newest quarter on record is ${quarterWords(newest)}.`,
    };
  }
  const q = targetOf(claim, evidence.quarters);
  if (!q) {
    const named = claim.fiscalQuarter ? `Q${claim.fiscalQuarter}${claim.fiscalYear ? ` ${claim.fiscalYear}` : ''}` : 'a recent quarter';
    return { verdict: 'cant_check', reason: `No reported earnings found for ${evidence.ticker} for ${named}.` };
  }

  const facts = factsText(q);
  const parts: Array<{ verdict: Verdict; lead: string }> = [];
  const outcome = outcomeOf(q);

  // "Beat", "missed", "in line".
  if (claim.vsEstimate) {
    if (!outcome) parts.push({ verdict: 'cant_check', lead: '' });
    else if (claim.vsEstimate === outcome) parts.push({ verdict: 'holds_up', lead: '' });
    else if (outcome === 'in_line') parts.push({ verdict: 'misleading', lead: `Earnings matched the estimate; they did not ${claim.vsEstimate === 'beat' ? 'beat' : 'miss'} it.` });
    else if (claim.vsEstimate === 'in_line') parts.push({ verdict: 'misleading', lead: `Earnings ${outcome === 'beat' ? 'beat' : 'missed'} the estimate rather than matching it.` });
    else parts.push({ verdict: 'contradicted', lead: `Earnings ${outcome === 'beat' ? 'beat' : 'missed'} the estimate. The post says they ${claim.vsEstimate === 'beat' ? 'beat' : 'missed'} it.` });

    // "Beat by 20%": how big the surprise was.
    if (claim.claimedPercent !== null && q.surprisePercent !== null && outcome && outcome !== 'in_line') {
      const actual = Math.abs(q.surprisePercent);
      const ok = Math.abs(claim.claimedPercent - actual) <= Math.max(SURPRISE_TIGHT_POINTS, actual * SURPRISE_TIGHT_RELATIVE);
      if (!ok) {
        const how = claim.claimedPercent > actual ? 'overstated' : 'understated';
        parts.push({ verdict: 'misleading', lead: `The size of the ${outcome} is ${how}: ${formatPercentMagnitude(actual)}, not ${formatPercentMagnitude(claim.claimedPercent)}.` });
      }
    }
  }

  // "EPS of $1.25".
  if (claim.claimedAmount !== null) {
    const claimed = claim.claimedAmount;
    if (q.actual === null) parts.push({ verdict: 'cant_check', lead: '' });
    else {
      const gap = Math.abs(claimed - q.actual);
      const close = gap <= Math.max(EPS_TIGHT_DOLLARS, Math.abs(q.actual) * EPS_TIGHT_RELATIVE);
      if (close) parts.push({ verdict: 'holds_up', lead: '' });
      else {
        const older = evidence.quarters.find((o) => o !== q && o.actual !== null && Math.abs(claimed - o.actual) <= EPS_TIGHT_DOLLARS);
        if (older) {
          parts.push({ verdict: 'misleading', lead: `${formatPerShare(claimed)} matches ${quarterWords(older)}, not the latest quarter.` });
        } else if (Math.sign(claimed) === Math.sign(q.actual) && gap <= Math.abs(q.actual) * EPS_LOOSE_RELATIVE) {
          parts.push({ verdict: 'misleading', lead: `Close, but ${Math.abs(claimed) > Math.abs(q.actual) ? 'overstated' : 'understated'}.` });
        } else {
          parts.push({ verdict: 'contradicted', lead: `The post says EPS of ${formatPerShare(claimed)}.` });
        }
      }
    }
  }

  const worst = parts.reduce((a, b) => (RANK[b.verdict] > RANK[a.verdict] ? b : a));
  if (worst.verdict === 'cant_check') return { verdict: 'cant_check', reason: `${facts} There is no estimate to compare the post with.` };
  const lead = parts.filter((p) => p.lead && p.verdict === worst.verdict).map((p) => p.lead).join(' ');
  return { verdict: worst.verdict, reason: `${lead ? `${lead} ` : ''}${facts}${BASIS_NOTE}` };
}

function figuresFor(quarters: EarningsQuarter[]): EvidenceFigure[] {
  return quarters.slice(0, 4).map((q) => ({
    label: quarterLabel(q),
    value:
      q.actual === null
        ? 'Not reported yet'
        : q.estimate === null
          ? `EPS ${formatPerShare(q.actual)}`
          : `EPS ${formatPerShare(q.actual)} vs est. ${formatPerShare(q.estimate)}`,
  }));
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function createFinnhubEarningsSource({ finnhub }: { finnhub: FinnhubClient }): EvidenceSource {
  return {
    id: 'finnhub-earnings',
    // Estimates and results change at most once a quarter.
    ttlMs: 6 * 60 * 60 * 1000,

    // Earnings per share only: an EPS beat is no evidence for a revenue, guidance or cash-flow claim.
    supports: (claim) => claim.type === 'earnings_result' && !claim.segment && (claim.metric === null || claim.metric === 'eps'),

    cacheKey: (claim) => `finnhub-earnings:${claim.ticker ?? ''}`,

    emptyReason: (claim) => `No earnings history found for ${claim.ticker}.`,

    async fetchEvidence(claim): Promise<Evidence | null> {
      if (!claim.ticker) return null;
      const rows = await finnhub.earnings(claim.ticker);
      const quarters: EarningsQuarter[] = rows
        .filter((r) => typeof r.period === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.period))
        .map((r) => {
          const actual = num(r.actual);
          const estimate = num(r.estimate);
          const surprise =
            num(r.surprisePercent) ?? (actual !== null && estimate !== null && estimate !== 0 ? ((actual - estimate) / Math.abs(estimate)) * 100 : null);
          const fq = r.quarter;
          return {
            period: r.period,
            fiscalYear: num(r.year),
            fiscalQuarter: fq === 1 || fq === 2 || fq === 3 || fq === 4 ? (fq as Quarter) : null,
            actual,
            estimate,
            surprisePercent: surprise,
          };
        })
        .sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));
      if (quarters.length === 0) return null;

      return {
        kind: 'earnings_result',
        sourceId: 'finnhub-earnings',
        ticker: claim.ticker,
        entityName: claim.ticker,
        asOf: quarters[0]!.period,
        quarters,
        figures: figuresFor(quarters),
        citation: {
          label: 'Finnhub earnings data (EPS vs analyst estimates)',
          url: `https://finance.yahoo.com/quote/${encodeURIComponent(claim.ticker)}/analysis/`,
        },
      };
    },

    evaluate(claim, evidence) {
      if (evidence.kind !== 'earnings_result') return { verdict: 'cant_check', reason: 'The data found does not match this claim.' };
      return evaluateEarningsClaim(claim, evidence);
    },
  };
}
