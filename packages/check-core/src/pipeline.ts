import type { EvidenceCache } from './cache';
import { addDays, newYorkDate, parsePostDate, parsePostTime, postDateInText, postStampInText, redditAge, weekdayOf } from './dates';
import type { ClaimExtractor } from './llm/types';
import { normalizeTicker } from './llm/normalize';
import { STALE_NOTE } from './sources/finnhub/marketSource';
import { namesMatch } from './sources/sec/client';
import type { CompanyDirectory, EvidenceSource } from './sources/types';
import { cleanPostText, postTimestamp } from './text';
import type { CheckResult, CheckedClaim, Claim, ClaimType, Evidence, ExtractedClaim, Metric, Period, Quarter } from './types';

// Shown when a claim is factual but no data source covers its type yet.
const NOT_BUILT_YET: Partial<Record<ClaimType, string>> = {
  financial_figure: 'Verifi can only check revenue, operating income and net income figures so far.',
  short_interest: "Verifi can't check short interest yet.",
  earnings_result: "Earnings estimates aren't connected, so this can't be checked right now.",
  consensus_estimate: "Earnings estimates aren't connected, so this can't be checked right now.",
  earnings_date: "The earnings calendar isn't connected, so this can't be checked right now.",
  price_move: "Market data isn't connected, so this can't be checked right now.",
  market_cap: "Market data isn't connected, so this can't be checked right now.",
};

// Earnings claims about something other than EPS. An EPS beat is never evidence for them.
const NOT_EPS: Partial<Record<Metric, string>> = {
  revenue: "Verifi checks beats and misses on earnings per share only. Revenue estimates aren't connected, and an EPS beat says nothing about revenue.",
  guidance: "Guidance is the company's forecast. Verifi doesn't check guidance against estimates, and an EPS beat says nothing about it.",
  free_cash_flow: "Verifi doesn't check free cash flow against estimates yet, and an EPS beat says nothing about it.",
  other: "Verifi checks beats and misses on earnings per share only.",
};

export const MAX_POST_LENGTH = 6000;

export interface CheckDeps {
  extractor: ClaimExtractor;
  sources: EvidenceSource[];
  cache?: EvidenceCache;
  /** Finds tickers for companies the post names without one. Optional. */
  directory?: CompanyDirectory;
  now?: () => Date;
}

export interface CheckOptions {
  /**
   * When the post was written: a Date, an ISO date, or what the app shows
   * ("Nov 9", "2d ago", "Monday"). "Today" and "this week" in the post are
   * read against this day. Without it, the date in a copied X author block is
   * used, or a line in the post that is only a date ("Nov 9th 2026").
   */
  postedAt?: string | Date | null;
}

export class InputError extends Error {}

// Claim types whose check depends on which year or quarter is meant.
const DATED_TYPES: ClaimType[] = ['financial_figure', 'revenue_growth', 'earnings_result'];

// Words that mean the quote picks its own period, so it must not borrow one.
const OWN_PERIOD = /\b(?:fy\s?'?\d{2,4}|q[1-4]|20\d\d|quarter|year|annual|annually|ttm|trailing|ytd|month|week|today|yesterday|recently|now|currently)\b/i;
// A period the post states outright ("Apr–Jun 2026") outranks loose words like "this quarter".
const EXPLICIT_PERIOD = /\b(?:fy\s?'?\d{2,4}|q[1-4]|20\d\d|annual|annually|full[- ]year|ttm|trailing|ytd|last (?:year|quarter)|month|week|today|yesterday)\b/i;

interface PostPeriod {
  fiscalYear: number;
  fiscalQuarter: Quarter | null;
  period: Period | null;
  /** True when it was read from the post's own words ("Apr–Jun 2026"), not from its claims. */
  stated?: boolean;
}

const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const MONTH_RANGE = new RegExp(`\\b${MONTH}\\s*(?:-|–|—|to|through|thru)\\s*${MONTH},?\\s*(20\\d\\d)\\b`, 'i');
const MONTHS_ENDED = new RegExp(`\\b(three|six|nine|twelve) months ended\\s+${MONTH}\\s+\\d{1,2},?\\s+(20\\d\\d)\\b`, 'i');
const MONTH_INDEX = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A calendar period the post states in words: "Apr–Jun 2026", "Jan-Dec 2025", "three months ended June 30, 2026". */
export function statedPostPeriod(text: string): PostPeriod | null {
  const range = text.match(MONTH_RANGE);
  if (range) {
    const from = MONTH_INDEX.indexOf(range[1]!.toLowerCase()) + 1;
    const to = MONTH_INDEX.indexOf(range[2]!.toLowerCase()) + 1;
    const year = Number(range[3]);
    if (to - from === 2 && from % 3 === 1) return { fiscalYear: year, fiscalQuarter: ((from + 2) / 3) as Quarter, period: 'quarter', stated: true };
    if (from === 1 && to === 12) return { fiscalYear: year, fiscalQuarter: null, period: 'year', stated: true };
    return null;
  }
  const ended = text.match(MONTHS_ENDED);
  if (ended && ended[1]!.toLowerCase() === 'three') {
    const month = MONTH_INDEX.indexOf(ended[2]!.toLowerCase()) + 1;
    if (month % 3 === 0) return { fiscalYear: Number(ended[3]), fiscalQuarter: (month / 3) as Quarter, period: 'quarter', stated: true };
  }
  return null;
}

/**
 * "$NVDA made $130B in FY2025 while $MSFT made over $280B": the second figure
 * means FY2025 too, but the extractor gives it no year, and a source then
 * checks it against the latest year instead. When every dated figure in the
 * post names the same period, undated figures borrow it. If the post names
 * two different periods, nothing is borrowed, since a guess could be wrong.
 * A period the post states in words ("Apr–Jun 2026") applies to every claim
 * that doesn't name its own.
 */
export function sharedPostPeriod(claims: ExtractedClaim[], postText = ''): PostPeriod | null {
  const stated = statedPostPeriod(postText);
  if (stated) return stated;
  const dated = claims.filter((c) => DATED_TYPES.includes(c.type) && c.fiscalYear !== null);
  if (dated.length === 0) return null;
  const first = dated[0]!;
  const same = dated.every((c) => c.fiscalYear === first.fiscalYear && c.fiscalQuarter === first.fiscalQuarter);
  if (!same) return null;
  return { fiscalYear: first.fiscalYear!, fiscalQuarter: first.fiscalQuarter, period: first.period ?? (first.fiscalQuarter ? 'quarter' : 'year') };
}

function borrowsPeriod(c: ExtractedClaim, p: PostPeriod): boolean {
  if (!DATED_TYPES.includes(c.type) || c.fiscalQuarter !== null) return false;
  // A stated period also fills in the quarter when the extractor took only its year.
  if (p.stated) return (c.fiscalYear === null || c.fiscalYear === p.fiscalYear) && !EXPLICIT_PERIOD.test(c.quote);
  return c.fiscalYear === null && !OWN_PERIOD.test(c.quote);
}

function periodLabel(p: PostPeriod): string {
  return p.fiscalQuarter ? `Q${p.fiscalQuarter} ${p.fiscalYear}` : `FY${p.fiscalYear}`;
}

/** Tickers the post itself shows: cashtags and chart or exchange labels ("NASDAQ: CRWV", "NYSE:VST"). */
export function postTickers(text: string): string[] {
  const found = [
    ...[...text.matchAll(/\$([A-Za-z]{1,5}(?:\.[A-Za-z])?)\b/g)].map((m) => m[1]),
    ...[...text.matchAll(/\b(?:NASDAQ|NYSE|NYSEARCA|AMEX|CBOE|OTC)\s*:\s*([A-Z]{1,5}(?:\.[A-Z])?)\b/gi)].map((m) => m[1]),
  ];
  return [...new Set(found.map((t) => normalizeTicker(t)).filter((t): t is string => Boolean(t)))];
}

// Two claims are the same claim when they say the same thing about the same thing.
function claimKey(c: ExtractedClaim): string {
  const facts = [c.claimedPercent, c.claimedAmount, c.direction, c.vsEstimate].some((v) => v !== null);
  const what = [c.type, c.ticker, c.metric, c.segment?.toLowerCase(), c.fiscalYear, c.fiscalQuarter, c.period, c.window, c.windowDays, c.reference, c.session, c.comparison, c.bound];
  return facts
    ? JSON.stringify([...what, c.claimedPercent, c.claimedAmount, c.direction, c.vsEstimate])
    : JSON.stringify([c.type, c.ticker, c.quote.toLowerCase().replace(/\W+/g, ' ').trim()]);
}

/** Drops repeats, keeping the first. */
export function dedupeClaims<T extends ExtractedClaim>(claims: T[]): T[] {
  const seen = new Set<string>();
  return claims.filter((c) => {
    const key = claimKey(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Give each claim the ticker of its own company.
 *  - A ticker the model put on another company's claim ("SoftBank sold its
 *    $NVDA stake") is dropped when the quote names both and the ticker's listed
 *    name isn't the claim's company.
 *  - A company named without a ticker is looked up in the SEC list.
 *  - A claim naming no company inherits the post's ticker when the post is
 *    about exactly one stock. A claim naming a different company never does.
 */
async function assignTickers(extracted: ExtractedClaim[], text: string, directory: CompanyDirectory | undefined): Promise<ExtractedClaim[]> {
  const titles = new Map<string, Promise<string | null>>();
  const titleOf = (t: string) => {
    if (!directory) return Promise.resolve(null);
    if (!titles.has(t)) titles.set(t, directory.titleOf(t).catch(() => null));
    return titles.get(t)!;
  };
  const byName = async (name: string) => (directory ? directory.findByName(name).catch(() => null) : null);

  // 1. The model's ticker, or a cashtag in the claim's own words. A "company"
  // that is only the ticker ("$NVDA", "NBIS") names no company: keep it as the
  // ticker, or step 2 reads it as a second company and drops the ticker.
  const claims = extracted.map((c) => {
    // "The S&P", "the Nasdaq": the index, tracked through its ETF, never S&P Global or Nasdaq Inc.
    const index = indexEtf(c.company) ?? (c.ticker === 'SPGI' && /\bS&P\b(?!\s+Global)/i.test(c.quote) ? 'SPY' : null);
    if (index) return { ...c, ticker: index, company: null };
    const asTicker = c.company && /^\$?[A-Z]{1,5}(?:[.-][A-Z])?$/.test(c.company.trim()) ? normalizeTicker(c.company.trim()) : null;
    const ticker = c.ticker ?? asTicker ?? postTickers(c.quote)[0] ?? null;
    return { ...c, ticker, company: asTicker && asTicker === ticker ? null : c.company };
  });

  // 2. A ticker on another company's claim.
  for (const c of claims) {
    if (!c.ticker || !c.company) continue;
    const title = await titleOf(c.ticker);
    if (!title || namesMatch(c.company, title)) continue;
    const others = claims.filter((o) => o !== c && o.ticker === c.ticker && o.company);
    const otherMatches = others.some((o) => namesMatch(o.company!, title));
    const t = c.ticker.replace(/\./g, '\\.');
    const quoteNamesTicker = new RegExp(`\\$${t}\\b|\\b${t}\\b`).test(c.quote) || namesInQuote(title, c.quote);
    if (otherMatches || (quoteNamesTicker && namesInQuote(c.company, c.quote))) c.ticker = null;
  }

  // 3. Inheritance and name lookup.
  const tickers = [...new Set([...claims.map((c) => c.ticker).filter((t): t is string => Boolean(t)), ...postTickers(text)])];
  const companies = [...new Set(claims.map((c) => c.company).filter((t): t is string => Boolean(t)))];
  const onlyTicker = tickers.length === 1 ? tickers[0]! : null;
  const onlyCompany = companies.length === 1 ? companies[0]! : null;
  // The company names that go with the post's only ticker.
  const ownerNames = claims.filter((c) => c.ticker === onlyTicker && c.company).map((c) => c.company!);

  for (const c of claims) {
    if (!c.company && onlyCompany && (!c.ticker || claims.some((o) => o.company === onlyCompany && o.ticker === c.ticker))) c.company = onlyCompany;
    if (c.ticker) continue;
    if (c.company) {
      const found = await byName(c.company);
      if (found) {
        c.ticker = found.ticker;
        continue;
      }
      if (!onlyTicker) continue;
      const title = await titleOf(onlyTicker);
      const same = ownerNames.some((n) => namesMatch(n, c.company!)) || (title ? namesMatch(c.company, title) : ownerNames.length === 0 && !directory);
      if (same) c.ticker = onlyTicker;
      continue;
    }
    c.ticker = onlyTicker;
  }
  return claims;
}

const INDEX_ETFS: Array<[RegExp, string]> = [
  [/^(?:the )?(?:s&p(?: 500)?|s&p500|spx)(?: index)?$/i, 'SPY'],
  [/^(?:the )?nasdaq(?:[- ]100| composite)?(?: index)?$/i, 'QQQ'],
  [/^(?:the )?dow(?: jones)?(?: industrial average)?$/i, 'DIA'],
  [/^(?:the )?russell 2000$/i, 'IWM'],
];

function indexEtf(company: string | null): string | null {
  const name = company?.trim();
  return (name && INDEX_ETFS.find(([re]) => re.test(name))?.[1]) || null;
}

// "Over the past month", "in one month", "last 30 days": a rolling month, not month to date.
const ROLLING_MONTH = /\b(?:past|last|over (?:the|a|one)|in (?:a|one)|one|same|prior)\s+month\b|\b(?:30|thirty) days\b/i;
const MONTH_TO_DATE = /\b(?:this month|so far (?:this|in) \w+|month[- ]to[- ]date|mtd)\b/i;

/** A "month" move the post measures over a rolling month becomes a 30-day span. */
function rollingMonth<C extends ExtractedClaim>(c: C, text: string): C {
  if (c.window !== 'month') return c;
  // The claim's own words first; then the post's framing ("In one month, healthcare rose 11%").
  const rolling = ROLLING_MONTH.test(c.quote) || (!MONTH_TO_DATE.test(c.quote) && ROLLING_MONTH.test(text));
  return rolling ? { ...c, window: null, windowDays: 30 } : c;
}

/**
 * Without a post date, "today" and "this week" mean the day of the check, which
 * is only a guess. A mismatch then says nothing about the post: it may be days old.
 */
function undatedGuess(claim: Claim): boolean {
  if (claim.postedAt) return false;
  if (claim.type === 'earnings_date') return !claim.eventDate || !/\d/.test(claim.eventDate);
  return shortMove(claim);
}

/** A price or market-value move over a month or less, which a day's error in the date can change. */
function shortMove(claim: Claim): boolean {
  if (claim.type !== 'price_move' && claim.type !== 'market_cap') return false;
  return claim.window === 'day' || claim.window === 'week' || claim.window === 'month' || (claim.windowDays !== null && claim.windowDays <= 31) || claim.session !== null;
}

const APPROX_NOTE = " The post's date comes from Reddit's rounded age (\"13d ago\"), which can be a day late, so the post may be about the session before. Add the exact date to check it."

// "An investment made ten years ago would be worth $7,800": a dollar value, not a share price.
const INVESTMENT_VALUE = /\b(?:invest(?:ed|ment|ing)?|would be worth|would have|turned into|grown to)\b/i;

/** Why a price claim is about something the price data can't show, or null. */
function priceClaimMismatch(claim: Claim, text: string, today: string): string | null {
  if (claim.type !== 'price_move' && claim.type !== 'market_cap') return null;
  if (claim.type === 'price_move' && claim.claimedAmount !== null && claim.claimedPercent === null && INVESTMENT_VALUE.test(text)) {
    return 'The figure looks like what an investment would be worth, not the share price, so there is no price to compare it with.';
  }
  // "2022 → -27.92%": one past calendar year, not the latest 52 weeks.
  const year = claim.quote.match(/\b(19\d{2}|20\d{2})\b/)?.[1];
  if (year && Number(year) < Number(today.slice(0, 4)) && !/\bsince\b/i.test(claim.quote)) {
    return `This is about the move in ${year}. Verifi checks moves over recent spans, not past calendar years yet.`;
  }
  return null;
}

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SESSION_WEEKDAY = /\b(monday|tuesday|wednesday|thursday|friday)(?:'s|’s)?\s+(?:close|closes|closing|session|trading)\b|\b(?:on|rose|fell|dropped|jumped|closed)\s+(?:on\s+)?(monday|tuesday|wednesday|thursday|friday)\b/gi;

/** The trading day a post names for its moves ("Monday's closes"), within the week before it. One day only. */
function namedSession(text: string, postedAt: string): string | null {
  const days = new Set([...text.matchAll(SESSION_WEEKDAY)].map((m) => (m[1] ?? m[2])!.toLowerCase()));
  if (days.size !== 1) return null;
  const target = WEEKDAY_NAMES.indexOf([...days][0]!);
  return addDays(postedAt, -((weekdayOf(postedAt) - target + 7) % 7));
}

const UNDATED_NOTE = " The post has no date, so this compares with today. If it was written on another day, add the post's date to check it against that day.";

/** True when the quote mentions the company by its identifying first word ("NVIDIA" in "NVIDIA CORP"). */
function namesInQuote(name: string, quote: string): boolean {
  const word = name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(' ')
    .find((w) => w.length >= 3 && !['the', 'inc', 'corp'].includes(w));
  return Boolean(word && new RegExp(`\\b${word}`, 'i').test(quote));
}

/**
 * The post's date as a New York day, and the exact moment it was made when that is
 * known. Throws InputError for a date that can't be read or is in the future.
 */
function resolvePostedAt(raw: string, options: CheckOptions, now: Date): { day: string | null; time: string | null } {
  let day: string | null = null;
  let time: string | null = null;
  const given = options.postedAt;
  if (given instanceof Date) {
    if (Number.isNaN(given.getTime())) throw new InputError("Couldn't read the post's date.");
    day = newYorkDate(given);
    time = given.toISOString();
  } else if (typeof given === 'string' && given.trim()) {
    time = parsePostTime(given, now);
    day = time ? newYorkDate(new Date(time)) : (parsePostDate(given, now) ?? postDateInText(given, now));
    if (!day) throw new InputError(`Couldn't read the post date "${given.trim().slice(0, 40)}". Use a date like Nov 9 or 2026-11-09, or leave it blank.`);
  } else {
    // The X author block, then a line in the post that is only its date ("Nov 9th 2026", "8:06 PM · Nov 11, 2026").
    const stamp = postTimestamp(raw);
    time = stamp ? parsePostTime(stamp, now) : null;
    day = time ? newYorkDate(new Date(time)) : stamp ? parsePostDate(stamp, now) : null;
    if (!day) {
      const line = postStampInText(raw.replace(/\r\n?/g, '\n'), now);
      day = line?.day ?? null;
      time = line?.time ?? null;
    }
  }
  if (day && day > newYorkDate(now)) throw new InputError("The post's date is in the future.");
  if (time && Date.parse(time) > now.getTime()) throw new InputError("The post's time is in the future.");
  return { day, time };
}

/**
 * The whole product in one function:
 *   1. the extractor reads the post and lists its claims
 *   2. each claim is routed to the data source that can check it
 *   3. the source fetches evidence (cached) and compares it with the claim
 * Clients send text in and render the CheckResult that comes out.
 */
export async function checkPost(postText: string, deps: CheckDeps, options: CheckOptions = {}): Promise<CheckResult> {
  const text = cleanPostText(postText);
  if (!text) throw new InputError('Paste a post to check.');
  if (text.length > MAX_POST_LENGTH) {
    throw new InputError(`That post is too long. The limit is ${MAX_POST_LENGTH} characters.`);
  }
  const now = deps.now?.() ?? new Date();
  const { day: postedAt, time: postedTime } = resolvePostedAt(postText, options, now);
  // A date from Reddit's rounded "13d ago" can be a day late: the session it points at is a guess.
  const approxDate = !options.postedAt && !postTimestamp(postText) && Boolean(redditAge(postText.replace(/\r\n?/g, '\n'), now)?.approximate);

  const extracted = dedupeClaims((await assignTickers(await deps.extractor.extractClaims(text), text, deps.directory)).map((c) => rollingMonth(c, text)));

  const tickers = [...new Set(extracted.map((c) => c.ticker).filter((t): t is string => Boolean(t)))];
  const companies = [...new Set(extracted.map((c) => c.company).filter((t): t is string => Boolean(t)))];
  const postTicker = tickers[0] ?? null;
  const postCompany = companies[0] ?? null;
  const postPeriod = sharedPostPeriod(extracted, text);

  const sessionDay = postedAt ? namedSession(text, postedAt) : null;

  // Claim ids whose year or quarter came from elsewhere in the post.
  const borrowed = new Set<string>();
  const claims: Claim[] = extracted.map((c, i) => {
    const id = `c${i + 1}`;
    // "Monday's closes: AMD +13%": a one-day move on the session the post names.
    const dayMove = (c.type === 'price_move' || c.type === 'market_cap') && c.window === 'day' && !c.session;
    const named = dayMove && sessionDay && sessionDay !== postedAt;
    const claim: Claim = { ...c, id, postedAt: named ? sessionDay : postedAt, postedTime: named ? null : postedTime };
    if (postPeriod && borrowsPeriod(c, postPeriod)) {
      borrowed.add(id);
      claim.fiscalYear = postPeriod.fiscalYear;
      claim.fiscalQuarter = postPeriod.fiscalQuarter;
      claim.period = postPeriod.period;
    }
    return claim;
  });

  // Several claims about one company share a single fetch within this check.
  const inFlight = new Map<string, Promise<Evidence | null>>();

  const fetchEvidence = async (source: EvidenceSource, claim: Claim): Promise<Evidence | null> => {
    const key = source.cacheKey(claim);
    const cached = await deps.cache?.get(key);
    if (cached) return cached;

    let pending = inFlight.get(key);
    if (!pending) {
      pending = source.fetchEvidence(claim).then(async (evidence) => {
        if (evidence) await deps.cache?.set(key, evidence, source.ttlMs);
        return evidence;
      });
      inFlight.set(key, pending);
    }
    return pending;
  };

  const checkOne = async (claim: Claim): Promise<CheckedClaim> => {
    const cant = (reason: string): CheckedClaim => ({ claim, verdict: 'cant_check', reason, evidence: null });

    if (claim.type === 'prediction') return cant('A prediction or price target, not a fact to verify.');
    if (claim.type === 'opinion') return cant('An opinion, not a fact to verify.');
    if (claim.type === 'personal') return cant("The poster's own gain or loss, not a fact about the company.");
    if (claim.type === 'consensus_estimate' && claim.metric !== 'eps' && claim.metric !== 'revenue') {
      return cant('Verifi checks the consensus for revenue and earnings per share only.');
    }
    if (claim.type === 'implied_move') return cant("An implied move comes from options prices, and Verifi doesn't have options data yet.");

    const mismatch = priceClaimMismatch(claim, text, postedAt ?? newYorkDate(now));
    if (mismatch) return cant(mismatch);

    // Without a ticker there are no filings to look up. This is the usual
    // result for private companies and for "leaked" documents.
    if (!claim.ticker) {
      return cant(
        claim.company
          ? `No stock ticker found for ${claim.company}. If it isn't publicly listed, there are no SEC filings to check this against.`
          : "The post doesn't say which company this is about.",
      );
    }

    // One business line: company totals are no evidence for it.
    if (claim.segment && (claim.type === 'revenue_growth' || claim.type === 'financial_figure' || claim.type === 'earnings_result')) {
      return cant(
        `This is about one business line (${claim.segment}). The SEC data Verifi reads has company totals only, and a total can't confirm or contradict one segment.`,
      );
    }
    if (claim.type === 'earnings_result' && claim.metric && claim.metric !== 'eps') return cant(NOT_EPS[claim.metric] ?? NOT_EPS.other!);

    const source = deps.sources.find((s) => s.supports(claim));
    if (!source) return cant(NOT_BUILT_YET[claim.type] ?? "Verifi can't check this kind of claim yet.");

    try {
      const evidence = await fetchEvidence(source, claim);
      if (!evidence) return cant(source.emptyReason?.(claim) ?? `No filing data found for ${claim.ticker}.`);
      const result = source.evaluate(claim, evidence);
      const { citation } = result;
      let { verdict, reason } = result;
      const withEvidence = citation ? { ...evidence, citation } : evidence;
      // A mismatch built on a guess (today's prices for an undated post, or a
      // period read from elsewhere in the post) is no proof the post is wrong.
      if (verdict === 'contradicted' && undatedGuess(claim)) {
        return { claim, verdict: 'cant_check', reason: `${reason.replace(STALE_NOTE, '')}${UNDATED_NOTE}`, evidence: withEvidence };
      }
      if (verdict === 'contradicted' && approxDate && claim.postedAt === postedAt && shortMove(claim)) {
        return { claim, verdict: 'cant_check', reason: `${reason}${APPROX_NOTE}`, evidence: withEvidence };
      }
      if (borrowed.has(claim.id) && postPeriod && verdict !== 'cant_check') {
        // "From $28.6B in FY2023 to $303B": next to an old year, a bare figure is often about now.
        const oldYear = postPeriod.fiscalYear !== null && postPeriod.fiscalYear < Number((postedAt ?? newYorkDate(now)).slice(0, 4)) - 1;
        if (verdict === 'contradicted' && oldYear) {
          verdict = 'cant_check';
          reason = `${reason} This figure doesn't name its own period, so it was checked against ${periodLabel(postPeriod)}, named earlier in the post. It may be about another period.`;
        } else {
          // Say so, so a reader can see why this year was used and not the latest one.
          reason = `${reason} The post names ${periodLabel(postPeriod)} earlier, so this figure is checked against that period.`;
        }
      }
      return { claim, verdict, reason, evidence: withEvidence };
    } catch {
      // One source being down should not fail the whole check.
      return cant("Couldn't reach the data source. Try again in a minute.");
    }
  };

  const checked = await Promise.all(claims.map(checkOne));
  const checkable = checked.filter((c) => c.verdict !== 'cant_check');

  return {
    ticker: postTicker,
    tickers,
    // Some sources only know the ticker, so prefer evidence that carries a real company name.
    entityName:
      tickers.length > 1
        ? null
        : // Some sources only know the ticker; a ticker is not a company name.
          checked.find((c) => c.evidence && c.evidence.entityName !== c.evidence.ticker)?.evidence?.entityName ?? postCompany,
    claims: checked,
    summary: {
      total: checked.length,
      checkable: checkable.length,
      holdsUp: checkable.filter((c) => c.verdict === 'holds_up').length,
    },
    extractor: deps.extractor.name,
    postedAt,
    postedTime,
    checkedAt: now.toISOString(),
  };
}
