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

/**
 * A quarter's fiscal label. A quarter read from an earnings release can come
 * without one: it is then the quarter after the next older labelled one.
 */
function fiscalLabel(quarters: ReportedPeriod[], i: number): { year: number; quarter: number } | null {
  const q = quarters[i]!;
  if (q.fiscalQuarter && q.fiscalYear) return { year: q.fiscalYear, quarter: q.fiscalQuarter };
  const prev = quarters[i + 1];
  if (!prev?.fiscalQuarter || !prev.fiscalYear) return null;
  const gapDays = (toTime(q.end) - toTime(prev.end)) / 86_400_000;
  if (gapDays < 80 || gapDays > 100) return null;
  return prev.fiscalQuarter === 4 ? { year: prev.fiscalYear + 1, quarter: 1 } : { year: prev.fiscalYear, quarter: prev.fiscalQuarter + 1 };
}

/**
 * "Q3" with no year, when the next quarter to be filed is a Q3: the post is
 * likely about that one (just reported, not filed yet), not last year's.
 */
export function upcomingNamedQuarter(quarters: ReportedPeriod[], quarter: number): string | null {
  const newest = quarters.length ? fiscalLabel(quarters, 0) : null;
  if (!newest) return null;
  const next = newest.quarter === 4 ? { year: newest.year + 1, quarter: 1 } : { year: newest.year, quarter: newest.quarter + 1 };
  return next.quarter === quarter ? `Q${next.quarter} ${next.year}` : null;
}

/**
 * Every quarter "Q2 2026" (or "Q2" with no year: the latest such) could mean:
 * the company's fiscal Q2 and the calendar Q2, which differ for companies whose
 * fiscal year doesn't start in January. A post that says "fiscal" or "FY" means
 * the fiscal label only. Newest first, no duplicates.
 */
export function namedQuarters(quarters: ReportedPeriod[], quarter: number, year: number | null, quote = ''): ReportedPeriod[] {
  const fiscal = quarters.find((q, i) => {
    const label = fiscalLabel(quarters, i);
    return label?.quarter === quarter && (year === null || label.year === year);
  });
  if (/\bfiscal\b|\bFY\s?'?\d/i.test(quote)) return fiscal ? [fiscal] : [];
  const calendar = quarters.find((q) => {
    const c = calendarOf(q);
    return c.quarter === quarter && (year === null || c.year === year);
  });
  return [...new Set([fiscal, calendar].filter((q): q is ReportedPeriod => Boolean(q)))].sort((a, b) => b.end.localeCompare(a.end));
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
