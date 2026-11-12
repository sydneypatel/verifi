import { formatDate } from '../../format';
import type { Claim, ReportedPeriod } from '../../types';
import { toTime, type SeriesPeriod } from './series';

// Which reported quarter or year a claim names. Shared by the dollar-figure
// and the revenue-growth checks, so "Q2 2026" means the same in both.

export function toReported(p: SeriesPeriod): ReportedPeriod {
  return {
    kind: p.kind,
    start: p.start,
    end: p.end,
    value: p.value,
    fiscalYear: p.fiscalYear,
    fiscalQuarter: p.fiscalQuarter,
    derived: p.derived,
    filing: { accession: p.accession, form: p.form, filed: p.filed, ...(p.url ? { url: p.url } : {}) },
    ...(p.firstFiled ? { firstFiled: p.firstFiled } : {}),
  };
}

/** The calendar quarter a period mostly falls in, for posts that use calendar labels. */
export function calendarOf(p: { start: string; end: string }): { year: number; quarter: number } {
  const middle = new Date((toTime(p.start) + toTime(p.end)) / 2);
  return { year: middle.getUTCFullYear(), quarter: Math.floor(middle.getUTCMonth() / 3) + 1 };
}

/** "Q2 2026" may be the company's fiscal label or the calendar quarter. Accept either. */
export function isQuarter(q: ReportedPeriod, year: number, quarter: number): boolean {
  const calendar = calendarOf(q);
  return (q.fiscalYear === year && q.fiscalQuarter === quarter) || (calendar.year === year && calendar.quarter === quarter);
}

/** "Q2" with no year: the most recent quarter with that label, fiscal or calendar. */
export function latestNamedQuarter(quarters: ReportedPeriod[], quarter: number): ReportedPeriod | undefined {
  return quarters.find((q) => q.fiscalQuarter === quarter || calendarOf(q).quarter === quarter);
}

export function isYear(y: ReportedPeriod, year: number): boolean {
  return y.fiscalYear === year || Number(y.end.slice(0, 4)) === year;
}

/** True when "Q{quarter} {year}" comes after the newest quarter on file. */
export function quarterAfter(latest: ReportedPeriod | undefined, year: number, quarter: number): boolean {
  if (!latest) return false;
  const later = (a: [number, number], b: [number, number]) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
  const cal = calendarOf(latest);
  const afterCalendar = later([year, quarter], [cal.year, cal.quarter]);
  // With fiscal labels, only when it is later by both readings: "Q1 2027" can be a fiscal label already filed.
  if (latest.fiscalYear !== null && latest.fiscalQuarter !== null) return afterCalendar && later([year, quarter], [latest.fiscalYear, latest.fiscalQuarter]);
  return afterCalendar;
}

export function yearAfter(latest: ReportedPeriod | undefined, year: number): boolean {
  if (!latest) return false;
  return year > Number(latest.end.slice(0, 4)) && (latest.fiscalYear === null || year > latest.fiscalYear);
}

/**
 * The periods a reader could have seen when the post was written: first
 * reported on or before that day. Without a post date, everything on file.
 */
export function onFileBy(periods: ReportedPeriod[], postedAt: string | null): ReportedPeriod[] {
  if (!postedAt) return periods;
  return periods.filter((p) => (p.firstFiled ?? p.filing.filed) <= postedAt);
}

export function periodWords(p: ReportedPeriod): string {
  if (p.kind === 'year') return `the fiscal year ended ${formatDate(p.end)}`;
  const label = p.fiscalQuarter && p.fiscalYear ? ` (fiscal Q${p.fiscalQuarter} ${p.fiscalYear})` : '';
  return `the quarter ended ${formatDate(p.end)}${label}`;
}

/** The reason for a claim whose named period is newer than anything filed. */
export function notFiledYet(named: string, newest: ReportedPeriod | undefined, ticker: string): string {
  const tail = newest ? ` The newest period on file is ${periodWords(newest)}.` : '';
  return `${named} isn't filed yet, so ${ticker}'s numbers for it can't be checked.${tail}`;
}

/** What the claim names, for messages: "Q3 2026", "fiscal year 2025". */
export function namedPeriod(claim: Pick<Claim, 'fiscalYear' | 'fiscalQuarter'>): string | null {
  if (claim.fiscalQuarter && claim.fiscalYear) return `Q${claim.fiscalQuarter} ${claim.fiscalYear}`;
  if (claim.fiscalYear) return `fiscal year ${claim.fiscalYear}`;
  return null;
}
