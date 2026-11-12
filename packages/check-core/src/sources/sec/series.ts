import type { Quarter } from '../../types';
import type { SecCompanyFacts, SecFact } from './client';

// Turns the SEC's raw list of facts for a concept into a clean time series of
// quarters and fiscal years. Shared by every source that reads income-statement
// numbers (revenue growth, dollar figures).

export const DAY = 86_400_000;

export function toTime(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

function toIso(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

export interface SeriesPeriod {
  kind: 'quarter' | 'year';
  start: string;
  end: string;
  value: number;
  fiscalYear: number | null;
  fiscalQuarter: Quarter | null;
  derived: boolean;
  accession: string;
  form: string;
  filed: string;
  /** When the period was first reported. Later filings repeat it as a comparison. */
  firstFiled?: string;
  /** A direct link to the document, when it is not the filing's folder (an earnings release exhibit). */
  url?: string;
}

export interface Series {
  concept: string;
  /** Newest first. */
  quarters: SeriesPeriod[];
  years: SeriesPeriod[];
}

const newestFirst = (a: SeriesPeriod, b: SeriesPeriod) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0);

function periodsOf(facts: SecFact[]): SeriesPeriod[] {
  // The same period shows up in several filings: once when first reported and
  // again as a comparison in later ones. Track the first and the latest.
  const groups = new Map<string, { first: SecFact; last: SecFact }>();
  for (const fact of facts) {
    if (!fact.start || typeof fact.val !== 'number') continue;
    const key = `${fact.start}|${fact.end}`;
    const group = groups.get(key);
    if (!group) groups.set(key, { first: fact, last: fact });
    else {
      if (fact.filed < group.first.filed) group.first = fact;
      if (fact.filed >= group.last.filed) group.last = fact;
    }
  }

  const periods: SeriesPeriod[] = [];
  for (const { first, last } of groups.values()) {
    const days = Math.round((toTime(last.end) - toTime(last.start!)) / DAY) + 1;
    // Year-to-date spans (six and nine months) are skipped.
    const kind = days >= 80 && days <= 100 ? 'quarter' : days >= 350 && days <= 380 ? 'year' : null;
    if (!kind) continue;

    // The fy/fp fields describe the filing, not the fact, so they only label a
    // period correctly in the filing that first reported it.
    const original = (toTime(first.filed) - toTime(first.end)) / DAY <= 120;
    const quarterNumber = original ? Number(first.fp?.match(/^Q([1-4])$/)?.[1]) || null : null;
    const filingYear = original && typeof first.fy === 'number' ? first.fy : null;

    periods.push({
      kind,
      start: last.start!,
      end: last.end,
      // The latest filing wins, so restated numbers are used.
      value: last.val,
      fiscalYear: kind === 'year' ? filingYear ?? Number(last.end.slice(0, 4)) : filingYear,
      fiscalQuarter: kind === 'quarter' ? (quarterNumber as Quarter | null) : null,
      derived: false,
      accession: last.accn,
      form: last.form,
      filed: last.filed,
      firstFiled: first.filed,
    });
  }
  return periods;
}

/**
 * Companies report the full year, not the fourth quarter on its own.
 * Where a year and its first three quarters are all present, Q4 is the difference.
 */
function deriveFourthQuarters(quarters: SeriesPeriod[], years: SeriesPeriod[]): SeriesPeriod[] {
  const derived: SeriesPeriod[] = [];
  for (const year of years) {
    const yearStart = toTime(year.start);
    const yearEnd = toTime(year.end);
    if (quarters.some((q) => Math.abs(toTime(q.end) - yearEnd) <= 5 * DAY)) continue;

    const inside = quarters.filter((q) => toTime(q.start) >= yearStart - 5 * DAY && toTime(q.end) < yearEnd - 60 * DAY);
    if (inside.length !== 3) continue;

    const lastEnd = Math.max(...inside.map((q) => toTime(q.end)));
    derived.push({
      kind: 'quarter',
      start: toIso(lastEnd + DAY),
      end: year.end,
      value: year.value - inside.reduce((sum, q) => sum + q.value, 0),
      fiscalYear: year.fiscalYear,
      fiscalQuarter: 4,
      derived: true,
      accession: year.accession,
      form: year.form,
      filed: year.filed,
      firstFiled: year.firstFiled,
    });
  }
  return derived;
}

export interface SeriesOptions {
  /**
   * When several concepts reach the newest period, use the one with the largest
   * value there. For revenue: some companies (Vistra) tag only part of their
   * sales as RevenueFromContractWithCustomer... and the total as Revenues, and
   * a headline revenue claim is about the total.
   */
  preferLargest?: boolean;
  /** The SEC unit to read. Dollars by default; per-share figures use "USD/shares". */
  unit?: string;
}

/** The value a concept reports for its newest period, quarters first. */
function newestValue(periods: SeriesPeriod[], newest: string): number {
  const at = periods.filter((p) => p.end === newest).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'quarter' ? -1 : 1));
  return at[0]?.value ?? -Infinity;
}

/**
 * Build the series for the first concept in the list that has the newest data.
 * Companies tag the same number under different names, and switch over time.
 */
export function buildSeries(facts: SecCompanyFacts, concepts: string[], options: SeriesOptions = {}): Series | null {
  const gaap = facts.facts['us-gaap'] ?? {};

  let best: { concept: string; periods: SeriesPeriod[]; newest: string } | null = null;
  for (const concept of concepts) {
    const usd = gaap[concept]?.units[options.unit ?? 'USD'];
    if (!usd?.length) continue;
    const periods = periodsOf(usd);
    if (periods.length === 0) continue;
    const newest = periods.reduce((max, p) => (p.end > max ? p.end : max), '');
    if (!best || newest > best.newest) best = { concept, periods, newest };
    else if (options.preferLargest && newest === best.newest && newestValue(periods, newest) > newestValue(best.periods, newest)) {
      best = { concept, periods, newest };
    }
  }
  if (!best) return null;

  const years = best.periods.filter((p) => p.kind === 'year').sort(newestFirst);
  const reported = best.periods.filter((p) => p.kind === 'quarter');
  const quarters = [...reported, ...deriveFourthQuarters(reported, years)].sort(newestFirst);

  return { concept: best.concept, quarters, years };
}

/** Find a period ending within about three weeks of the target date. */
export function endingNear<T extends { end: string }>(periods: T[], targetEnd: number): T | undefined {
  return periods.find((p) => Math.abs(toTime(p.end) - targetEnd) <= 20 * DAY);
}
