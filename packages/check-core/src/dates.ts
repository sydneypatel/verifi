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

export function weekdayOf(iso: string): number {
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
/** The moment a New York wall-clock time happened, as ISO (UTC). */
export function newYorkInstant(day: string, minuteOfDay: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const hh = Math.floor(minuteOfDay / 60);
  const mm = minuteOfDay % 60;
  // New York is UTC-5 or UTC-4; the right one gives back the same wall clock.
  for (const offset of [5, 4]) {
    const at = new Date(Date.UTC(y, m - 1, d, hh + offset, mm));
    if (newYorkDate(at) === day && nyClock(at) === minuteOfDay) return at.toISOString();
  }
  return new Date(Date.UTC(y, m - 1, d, hh + 5, mm)).toISOString();
}

const nyClockFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function nyClock(at: Date): number {
  const parts = nyClockFormat.formatToParts(at);
  return Number(parts.find((p) => p.type === 'hour')!.value) * 60 + Number(parts.find((p) => p.type === 'minute')!.value);
}

// "8:06 PM", "20:06", "8:06pm ET".
const CLOCK = /\b(\d{1,2}):(\d{2})(?::\d{2})?\s?([ap]\.?m\.?)?(?:\s?(?:et|est|edt))?\b/i;

/**
 * The exact moment a post was made, as ISO, or null when only its day is known.
 * Read from a timestamp, a clock time with a date ("8:06 PM · Nov 11, 2026", taken
 * as New York time), or an age in seconds or minutes ("45m"). Ages in hours or days
 * are rounded by the apps (5h can be 5h59m), so they give a day, not a time.
 */
export function parsePostTime(input: string, now: Date): string | null {
  const raw = input.trim();
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/i.test(raw)) {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  const text = raw.toLowerCase().replace(/^posted\s+/, '').replace(/\./g, '').replace(/\s+/g, ' ');
  if (text === 'now' || text === 'just now') return now.toISOString();
  const rel = text.match(/^(\d+)\s?(s|sec|secs|second|seconds|m|min|mins|minute|minutes)(?: ago)?$/);
  if (rel) return new Date(now.getTime() - Number(rel[1]) * UNIT_MS[rel[2]!]!).toISOString();

  const clock = raw.match(CLOCK);
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = Number(clock[2]);
  const ampm = clock[3]?.toLowerCase().replace(/\./g, '');
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const rest = raw
    .replace(clock[0], ' ')
    .split(/\s*[·•|,]\s*|\s+-\s+|\s+at\s+/i)
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' ');
  const day = rest ? parsePostDate(rest, now) : null;
  if (!day) return null;
  const at = newYorkInstant(day, hour * 60 + minute);
  return Date.parse(at) <= now.getTime() ? at : null;
}

/**
 * A copied Reddit header ("r/investing", "•", "2d ago", "u/name"): there the
 * relative age is the post's, so it is trusted even though it stands alone.
 * Reddit rounds ages down, so an age in days or weeks can put the post a day
 * (or more) later than it was: approximate is then true.
 */
export function redditAge(text: string, now: Date): { day: string; approximate: boolean } | null {
  const head = text.split(/\n/).map((l) => l.trim()).filter(Boolean).slice(0, 6);
  if (!head.some((l) => /^r\/\w+$/i.test(l))) return null;
  const age = head.map((l) => l.replace(/^[·•]\s*/, '')).find((l) => /^\d+\s?(?:m|min|h|hr|d|w)\s+ago$/i.test(l));
  const day = age ? parsePostDate(age, now) : null;
  return day ? { day, approximate: /\d\s?[dw]\s/i.test(age!) } : null;
}

export function postDateInText(text: string, now: Date): string | null {
  return postStampInText(text, now)?.day ?? null;
}

/** The post's day from a line of its own, and its exact time when that line has one ("8:06 PM · Nov 11, 2026"). */
export function postStampInText(text: string, now: Date): { day: string; time: string | null } | null {
  const reddit = redditAge(text, now);
  if (reddit) return { day: reddit.day, time: null };
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
    if (parts.every((p, i) => i === found || DATE_LINE_NOISE.test(p))) {
      const clock = parts.find((p) => CLOCK.test(p));
      const time = clock ? parsePostTime(`${clock} · ${parts[found]}`, now) : null;
      return { day: dates[found]!, time: time && newYorkDate(new Date(time)) === dates[found] ? time : null };
    }
  }
  return null;
}

/**
 * The day (or days) a post means by "today", "tomorrow", "Thursday", "Nov 19",
 * "this week" or "next week", counted from the post's date. Unlike a post date,
 * this can be in the future: "reports Thursday" means the coming Thursday.
 */
export function resolveEventDay(text: string, base: string): { from: string; to: string } | null {
  const t = text.trim().toLowerCase().replace(/^on\s+/, '');
  const one = (d: string) => ({ from: d, to: d });
  if (t === 'today' || t === 'tonight') return one(base);
  if (t === 'tomorrow') return one(addDays(base, 1));
  const monday = addDays(base, -((weekdayOf(base) + 6) % 7));
  if (t === 'this week') return { from: monday, to: addDays(monday, 4) };
  if (t === 'next week') return { from: addDays(monday, 7), to: addDays(monday, 11) };
  const wd = t.match(/^(?:this |next )?([a-z]{3})[a-z]*$/);
  if (wd && WEEKDAYS.includes(wd[1]!)) {
    const ahead = (WEEKDAYS.indexOf(wd[1]!) - weekdayOf(base) + 7) % 7;
    return one(addDays(base, ahead + (t.startsWith('next ') && ahead === 0 ? 7 : 0)));
  }
  const md = t.match(/^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/);
  if (md) {
    const month = MONTHS[md[1]!.slice(0, 3)];
    if (!month) return null;
    const year = md[3] ? Number(md[3]) : Number(base.slice(0, 4));
    let day = validDate(year, month, Number(md[2]));
    // "Jan 8" in a December post is next January.
    if (day && !md[3] && daysBetween(base, day) < -60) day = validDate(year + 1, month, Number(md[2]));
    return day ? one(day) : null;
  }
  const iso = parsePostDate(t, new Date(`${base}T12:00:00Z`));
  return iso && /\d/.test(t) ? one(iso) : null;
}
