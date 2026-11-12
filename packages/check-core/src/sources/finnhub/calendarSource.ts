import { addDays, newYorkDate, resolveEventDay } from '../../dates';
import { formatDate, formatPerShare, formatUsd } from '../../format';
import type { CalendarEvidence, CalendarReport, Claim, Evidence, EvidenceFigure, Quarter } from '../../types';
import type { Evaluation, EvidenceSource } from '../types';
import type { FinnhubClient } from './client';

// Checks "reports earnings today after close" and "the expectations are: EPS
// $4.06, revenue $10.3B" against Finnhub's earnings calendar, which lists each
// report's date, time of day and the analyst consensus before it.

/** Consensus figures differ a little between data providers, so a post quoting another provider still holds up. */
export const CONSENSUS_TIGHT = 0.03;
export const CONSENSUS_LOOSE = 0.1;
/** EPS is quoted to the cent; two cents covers rounding and provider differences on small figures. */
export const CONSENSUS_EPS_CENTS = 0.02;

const HOURS: Record<NonNullable<CalendarReport['hour']>, string> = {
  bmo: 'before the open',
  amc: 'after the close',
  dmh: 'during market hours',
};

const PROVIDER_NOTE = ' Consensus figures differ slightly between data providers.';

function reportWords(r: CalendarReport, ticker: string): string {
  const label = r.fiscalQuarter && r.fiscalYear ? `Q${r.fiscalQuarter} ${r.fiscalYear} ` : '';
  return `${ticker}'s ${label}report on ${formatDate(r.date)}${r.hour ? `, ${HOURS[r.hour]}` : ''}`;
}

/** The report the claim is about: the quarter it names, or the next one on or after the post's date. */
function targetReport(claim: Claim, reports: CalendarReport[], base: string): CalendarReport | undefined {
  if (claim.fiscalQuarter && claim.fiscalYear) {
    const named = reports.find((r) => r.fiscalQuarter === claim.fiscalQuarter && r.fiscalYear === claim.fiscalYear);
    if (named) return named;
  }
  // Within a few days after the post too: "expectations were" written the morning after.
  return reports.find((r) => r.date >= base) ?? [...reports].reverse().find((r) => r.date >= addDays(base, -3));
}

/** Pure comparison of an earnings-date or consensus claim with the calendar. */
export function evaluateCalendarClaim(claim: Claim, evidence: CalendarEvidence, today: string): Evaluation {
  const base = claim.postedAt ?? today;
  const report = targetReport(claim, evidence.reports, base);
  if (!report) {
    return { verdict: 'cant_check', reason: `No earnings report on the calendar for ${evidence.ticker} near ${formatDate(base)}.` };
  }
  const about = reportWords(report, evidence.ticker);

  if (claim.type === 'earnings_date') {
    const range = claim.eventDate ? resolveEventDay(claim.eventDate, base) : null;
    const wantHour = claim.session === 'after_hours' ? 'amc' : claim.session === 'pre_market' ? 'bmo' : null;
    if (!range && !wantHour) return { verdict: 'cant_check', reason: `The post doesn't say when ${evidence.ticker} reports. The calendar has ${about}.` };
    const fact = `The earnings calendar has ${about}.`;
    if (range && (report.date < range.from || report.date > range.to)) {
      const said = range.from === range.to ? formatDate(range.from) : `${formatDate(range.from)} to ${formatDate(range.to)}`;
      return { verdict: 'contradicted', reason: `${fact} The post says ${said}.` };
    }
    if (wantHour && report.hour && report.hour !== 'dmh' && report.hour !== wantHour) {
      return { verdict: 'contradicted', reason: `${fact} The post says ${HOURS[wantHour]}.` };
    }
    const unknownHour = wantHour && (!report.hour || report.hour === 'dmh') ? " The calendar doesn't say whether it is before the open or after the close." : '';
    return { verdict: 'holds_up', reason: `${fact}${unknownHour}` };
  }

  // Consensus estimate.
  const eps = claim.metric === 'eps';
  const consensus = eps ? report.epsEstimate : report.revenueEstimate;
  const claimed = claim.claimedAmount;
  if (claimed === null) return { verdict: 'cant_check', reason: "The post doesn't give a figure to compare with the consensus." };
  if (consensus === null) {
    return { verdict: 'cant_check', reason: `The calendar has no ${eps ? 'EPS' : 'revenue'} consensus for ${about}.` };
  }
  const show = (v: number) => (eps ? formatPerShare(v) : formatUsd(v));
  const actual = eps ? report.epsActual : report.revenueActual;
  const since = actual !== null ? ` The company has since reported ${show(actual)}.` : '';
  const fact = `The analyst consensus for ${about} is ${eps ? 'EPS of ' : 'revenue of '}${show(consensus)}.`;
  const gap = Math.abs(claimed - consensus);
  const tight = Math.max(Math.abs(consensus) * CONSENSUS_TIGHT, eps ? CONSENSUS_EPS_CENTS : 0);
  const loose = Math.max(Math.abs(consensus) * CONSENSUS_LOOSE, eps ? CONSENSUS_EPS_CENTS * 2 : 0);
  if (gap <= tight) return { verdict: 'holds_up', reason: `${fact}${gap > 0 ? PROVIDER_NOTE : ''}${since}` };
  const how = Math.abs(claimed) > Math.abs(consensus) ? 'higher' : 'lower';
  if (gap <= loose) return { verdict: 'misleading', reason: `Close, but ${how} than the consensus. ${fact} The post says ${show(claimed)}.${PROVIDER_NOTE}${since}` };
  return { verdict: 'contradicted', reason: `${fact} The post says ${show(claimed)}.${since}` };
}

function figuresFor(reports: CalendarReport[], ticker: string): EvidenceFigure[] {
  const rows: EvidenceFigure[] = [];
  for (const r of reports.slice(-2).reverse()) {
    rows.push({ label: 'Report', value: reportWords(r, ticker).replace(`${ticker}'s `, '') });
    if (r.epsEstimate !== null) rows.push({ label: '  EPS consensus', value: formatPerShare(r.epsEstimate) });
    if (r.revenueEstimate !== null) rows.push({ label: '  Revenue consensus', value: formatUsd(r.revenueEstimate) });
    if (r.epsActual !== null) rows.push({ label: '  EPS reported', value: formatPerShare(r.epsActual) });
    if (r.revenueActual !== null) rows.push({ label: '  Revenue reported', value: formatUsd(r.revenueActual) });
  }
  return rows;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function createFinnhubCalendarSource({ finnhub, now = () => new Date() }: { finnhub: FinnhubClient; now?: () => Date }): EvidenceSource {
  return {
    id: 'finnhub-calendar',
    // Dates can move and consensus figures drift until the report.
    ttlMs: 60 * 60 * 1000,

    supports: (c) =>
      (c.type === 'consensus_estimate' && (c.metric === 'eps' || c.metric === 'revenue') && c.claimedAmount !== null) || c.type === 'earnings_date',

    cacheKey: (c) => `finnhub-calendar:${c.ticker ?? ''}:${c.postedAt ?? ''}`,

    emptyReason: (c) => `No earnings reports on the calendar for ${c.ticker} around that date.`,

    async fetchEvidence(claim): Promise<Evidence | null> {
      if (!claim.ticker) return null;
      const base = claim.postedAt ?? newYorkDate(now());
      const rows = await finnhub.earningsCalendar(claim.ticker, addDays(base, -45), addDays(base, 100));
      const reports: CalendarReport[] = rows
        .filter((r) => typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date))
        .map((r): CalendarReport => ({
          date: r.date,
          hour: r.hour === 'bmo' || r.hour === 'amc' || r.hour === 'dmh' ? r.hour : null,
          fiscalYear: num(r.year),
          fiscalQuarter: r.quarter === 1 || r.quarter === 2 || r.quarter === 3 || r.quarter === 4 ? (r.quarter as Quarter) : null,
          epsEstimate: num(r.epsEstimate),
          revenueEstimate: num(r.revenueEstimate),
          epsActual: num(r.epsActual),
          revenueActual: num(r.revenueActual),
        }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      if (reports.length === 0) return null;
      return {
        kind: 'earnings_calendar',
        sourceId: 'finnhub-calendar',
        ticker: claim.ticker,
        entityName: claim.ticker,
        asOf: reports[reports.length - 1]!.date,
        reports,
        figures: figuresFor(reports, claim.ticker),
        citation: {
          label: 'Finnhub earnings calendar (dates and analyst consensus)',
          url: `https://finance.yahoo.com/quote/${encodeURIComponent(claim.ticker)}/analysis/`,
        },
      };
    },

    evaluate(claim, evidence) {
      if (evidence.kind !== 'earnings_calendar') return { verdict: 'cant_check', reason: 'The data found does not match this claim.' };
      return evaluateCalendarClaim(claim, evidence, newYorkDate(now()));
    },
  };
}
