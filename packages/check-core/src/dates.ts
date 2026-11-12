// Post dates. A post says "today" or "this week" about the day it was written,
// not the day it is checked, so every relative phrase is resolved against the
// post's own date. Dates are New York calendar days, where US markets keep time.

const DAY_MS = 86_400_000;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const UNIT_MS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: DAY_MS, day: DAY_MS, days: DAY_MS,
  w: 7 * DAY_MS, wk: 7 * DAY_MS, wks: 7 * DAY_MS, week: 7 * DAY_MS, weeks: 7 * DAY_MS,
};

const pad = (n: number) => String(n).padStart(2, '0');

/** The New York calendar day of a moment, as YYYY-MM-DD. */
export function newYorkDate(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Calendar arithmetic on YYYY-MM-DD strings, no time zones. */
export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from a to b (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

function validDate(y: number, m: number, d: number): string | null {
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.getUTCMonth() + 1 === m && t.getUTCDate() === d ? iso : null;
}

/**
 * Reads a post date the way social apps print it and returns the New York day:
 *   "2026-11-09", an ISO timestamp, "Nov 9", "Nov 9, 2025", "9 Nov 2025",
 *   "2d", "2d ago", "17h", "3 days ago", "today", "yesterday", "Monday", "last Mon".
 * A date with no year is the latest one that is not in the future.
 * Returns null when the text isn't a date.
 */
export function parsePostDate(input: string, now: Date): string | null {
  const text = input.trim().toLowerCase().replace(/^posted\s+/, '').replace(/\s+/g, ' ');
  if (!text) return null;
  const today = newYorkDate(now);

  // ISO: a calendar day is taken as written; a timestamp is converted to New York.
  // "11/9/2026", "11/09/26": US order, as US apps print it.
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (us) return validDate(us[3]!.length === 2 ? 2000 + Number(us[3]) : Number(us[3]), Number(us[1]), Number(us[2]));

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  if (/^\d{4}-\d{2}-\d{2}t/.test(text)) {
    const t = Date.parse(input.trim());
    return Number.isNaN(t) ? null : newYorkDate(new Date(t));
  }

  if (text === 'today' || text === 'now' || text === 'just now') return today;
  if (text === 'yesterday') return addDays(today, -1);

  // "2d", "17h ago", "3 days ago"
  const rel = text.replace(/\./g, '').match(/^(\d+)\s?([a-z]+)(?: ago)?$/);
  if (rel && UNIT_MS[rel[2]!]) return newYorkDate(new Date(now.getTime() - Number(rel[1]) * UNIT_MS[rel[2]!]!));

  // "Monday", "last Mon": the latest such day, today included unless "last" is said.
  const wd = text.match(/^(last )?([a-z]{3})[a-z]*$/);
  if (wd && WEEKDAYS.includes(wd[2]!)) {
    const target = WEEKDAYS.indexOf(wd[2]!);
    let back = (weekdayOf(today) - target + 7) % 7;
    if (back === 0 && wd[1]) back = 7;
    return addDays(today, -back);
  }

  // "Nov 9", "November 9, 2025", "9 Nov 2025"
  const md = text.match(/^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/) ?? null;
  const dm = md ? null : text.match(/^(\d{1,2}) ([a-z]{3,9})\.?(?:,? (\d{4}))?$/);
  const monthWord = md?.[1] ?? dm?.[2];
  const dayNum = md?.[2] ?? dm?.[1];
  const yearNum = md?.[3] ?? dm?.[3];
  if (monthWord && dayNum) {
    const month = MONTHS[monthWord.slice(0, 4) === 'sept' ? 'sept' : monthWord.slice(0, 3)];
    if (!month) return null;
    if (yearNum) return validDate(Number(yearNum), month, Number(dayNum));
    const thisYear = Number(today.slice(0, 4));
    const candidate = validDate(thisYear, month, Number(dayNum));
    if (!candidate) return null;
    return candidate > today ? validDate(thisYear - 1, month, Number(dayNum)) : candidate;
  }
  return null;
}

// Parts of a date line that aren't the date: "10:32 AM", "12.3K Views", "Edited".
const DATE_LINE_NOISE = /^(?:\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?(?:\s?[a-z]{2,4})?|\d+(?:[.,]\d+)?[km]?\s+views?|edited|posted(?: on)?|sent|from \w+)$/i;

/**
 * A line in the post that is only its date: "Nov 9th 2026", "Posted Nov 9, 2026",
 * "10:32 AM · Nov 9, 2026 · 12.3K Views" (X), "11/9/2026". Only the first and last
 * few lines are read, and only lines that are a date and nothing else, so a date
 * inside a claim ("revenue for the quarter ended Sep 30, 2026") is never taken.
 * Returns the New York day, or null.
 */
export function postDateInText(text: string, now: Date): string | null {
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const candidates = [...lines.slice(-3).reverse(), ...lines.slice(0, 3)];
  for (const line of candidates) {
    if (line.length > 80) continue;
    const parts = line
      .replace(/^posted(?: on)?:?\s+/i, '')
      .split(/\s+[·•|]\s+|\s+-\s+/)
      .map((p) => p.trim().replace(/[.,]$/, ''))
      .filter(Boolean);
    const dates = parts.map((p) => parsePostDate(p, now));
    const found = dates.findIndex(Boolean);
    if (found === -1) continue;
    // Relative words ("2d", "Monday") alone on a line are too loose to trust; written-out dates are not.
    if (!/\d{4}|[a-z]{3,9}\.? \d{1,2}|\d{1,2}\/\d{1,2}/i.test(parts[found]!)) continue;
    if (parts.every((p, i) => i === found || DATE_LINE_NOISE.test(p))) return dates[found]!;
  }
  return null;
}
