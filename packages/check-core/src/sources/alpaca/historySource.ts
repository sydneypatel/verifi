import { addDays, daysBetween, newYorkDate } from '../../dates';
import { describeChange, formatDate, formatPercentMagnitude, formatPrice, formatSignedPercent, formatUsd } from '../../format';
import type { Claim, Evidence, EvidenceFigure, PriceHistoryEvidence, PricePoint } from '../../types';
import type { FinnhubClient } from '../finnhub/client';
import { CAP_LOOSE, CAP_TIGHT, PRICE_LOOSE, PRICE_MIN_POINTS, PRICE_TOLERANCE, agrees } from '../finnhub/marketSource';
import type { Evaluation, EvidenceSource } from '../types';
import { HISTORY_START, type DailyBar, type IntradayBar, type PriceHistory } from './history';

// Checks price claims against the post's own trading day: "up 12% today" on a
// post from last Monday is measured on last Monday, "this week" on that week,
// "down 30% from its highs" against the highs before it. Finnhub still answers
// claims about the current session; this source takes the rest.

const PRE_OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;

/** True when a claim can't be checked against the latest price alone. */
export function needsHistory(claim: Claim, today: string): boolean {
  return Boolean(claim.postedAt && claim.postedAt < today) || claim.windowDays !== null || claim.reference !== null || claim.session !== null;
}

function weekStart(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

/** Index of the last bar on or before (or strictly before) a day. */
function lastOnOrBefore(bars: DailyBar[], date: string, strict = false): number {
  for (let i = bars.length - 1; i >= 0; i--) if (strict ? bars[i]!.date < date : bars[i]!.date <= date) return i;
  return -1;
}

const pct = (to: number, from: number) => (to / from - 1) * 100;

/** Listed after the free history begins, so its whole trading history is on record. */
const completeHistory = (first: string) => daysBetween(HISTORY_START, first) > 14;

interface Span {
  label: string;
  from: PricePoint;
}

/** The close the claim's span starts from, or why it can't be measured. */
function spanStart(claim: Claim, bars: DailyBar[], end: number): Span | { reason: string } {
  const e = bars[end]!;
  const first = bars[0]!;
  const tooOld = { reason: `Price history for ${claim.ticker} starts ${formatDate(first.date)}, so a move over that span can't be measured.` };
  const at = (i: number, label: string): Span | { reason: string } => (i < 0 ? tooOld : { label, from: { date: bars[i]!.date, price: bars[i]!.close } });

  if (claim.windowDays !== null && !claim.window) {
    const days = claim.windowDays;
    if (days >= 36500) {
      if (!completeHistory(first.date)) {
        return { reason: `Price history for ${claim.ticker} only goes back to ${formatDate(first.date)}, so a move since its first trading day can't be checked.` };
      }
      return { label: `since its first trading day, ${formatDate(first.date)}`, from: { date: first.date, price: first.open } };
    }
    const span = days % 365 === 0 ? `${days / 365} year${days === 365 ? '' : 's'}` : `${days} days`;
    return at(lastOnOrBefore(bars, addDays(e.date, -days)), `over the ${span} to ${formatDate(e.date)}`);
  }

  switch (claim.window) {
    case 'day':
      return at(end - 1, `on ${formatDate(e.date)}`);
    case 'week': {
      if (/\bthis week\b/i.test(claim.quote)) {
        const monday = weekStart(e.date);
        return at(lastOnOrBefore(bars, monday, true), `the week of ${formatDate(monday)}, through ${formatDate(e.date)}`);
      }
      return at(end - 5, `over the 5 trading days to ${formatDate(e.date)}`);
    }
    case 'month':
      if (/\b(?:past|last) month\b|\b30 days\b/i.test(claim.quote)) return at(lastOnOrBefore(bars, addDays(e.date, -30)), `over the month to ${formatDate(e.date)}`);
      return at(lastOnOrBefore(bars, `${e.date.slice(0, 7)}-01`, true), `so far in ${new Date(`${e.date}T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })}, through ${formatDate(e.date)}`);
    case 'ytd':
      return at(lastOnOrBefore(bars, `${e.date.slice(0, 4)}-01-01`, true), `so far in ${e.date.slice(0, 4)}, through ${formatDate(e.date)}`);
    case 'year':
      return at(lastOnOrBefore(bars, addDays(e.date, -365)), `over the year to ${formatDate(e.date)}`);
    default:
      return { reason: "The post doesn't say over what period, so there is no change to compare." };
  }
}

/**
 * Everything the claim needs, measured from the history. Pure, so it can be tested
 * without a network: bars oldest first, the extended-hours bars of the session day
 * if the claim is about one, and today's market value and price if known.
 */
export function measureHistory(
  claim: Claim,
  bars: DailyBar[],
  options: { today: string; intraday?: IntradayBar[]; marketCap?: number | null; entityName?: string; label?: string },
): PriceHistoryEvidence {
  const ticker = claim.ticker ?? '';
  const target = claim.postedAt ?? options.today;
  const end = lastOnOrBefore(bars, target);
  const first = bars[0]!;
  const latest = bars[bars.length - 1]!;
  const base = {
    kind: 'price_history' as const,
    sourceId: 'price-history',
    ticker,
    entityName: options.entityName || ticker,
    figures: [] as EvidenceFigure[],
    citation: {
      label: `${options.label ?? 'Daily price history'}, ${formatDate(target)}`,
      url: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/history/`,
    },
    firstDate: first.date,
  };
  if (end < 0) {
    return {
      ...base,
      asOf: first.date,
      sessionDate: first.date,
      intraday: false,
      settled: true,
      session: { open: first.open, high: first.high, low: first.low, close: first.close },
      unavailable: `Price history for ${ticker} starts ${formatDate(first.date)}, after the post's date.`,
    };
  }
  const e = bars[end]!;
  const evidence: PriceHistoryEvidence = {
    ...base,
    asOf: e.date,
    sessionDate: e.date,
    // Without a post date, or when it was written on the session's day, it may have been written mid-session.
    intraday: claim.postedAt ? claim.postedAt === e.date : true,
    settled: e.date < options.today,
    session: { open: e.open, high: e.high, low: e.low, close: e.close },
  };
  if (options.marketCap && latest.close > 0) evidence.marketCap = options.marketCap * (e.close / latest.close);

  if (claim.type === 'price_move' && claim.session) {
    const day = options.intraday ?? [];
    const pre = claim.session === 'pre_market';
    const trades = day.filter((b) => (pre ? b.minute < PRE_OPEN : b.minute >= CLOSE));
    const from = pre ? bars[end - 1] : e;
    if (trades.length === 0 || !from) {
      evidence.unavailable = `The price data has no ${pre ? 'pre-market' : 'after-hours'} trades for ${ticker} on ${formatDate(e.date)}.`;
    } else {
      const last = trades[trades.length - 1]!;
      evidence.extended = {
        kind: claim.session,
        base: { date: from.date, price: from.close },
        last: { date: e.date, price: last.close },
        percent: pct(last.close, from.close),
        lowPercent: pct(Math.min(...trades.map((t) => t.low)), from.close),
        highPercent: pct(Math.max(...trades.map((t) => t.high)), from.close),
      };
    }
  } else if (claim.type === 'price_move' && claim.reference) {
    if (claim.reference === 'high_52_week') {
      const yearAgo = addDays(e.date, -365);
      if (first.date > yearAgo) {
        evidence.unavailable = `Price history for ${ticker} starts ${formatDate(first.date)}, less than 52 weeks before the post.`;
      } else {
        const inYear = bars.slice(0, end + 1).filter((b) => b.date > yearAgo);
        const top = inYear.reduce((a, b) => (b.high > a.high ? b : a));
        evidence.high = { price: top.high, date: top.date, scope: '52_week', complete: true };
      }
    } else {
      const complete = completeHistory(first.date);
      if (claim.reference === 'high_all_time' && !complete) {
        evidence.unavailable = `Price history for ${ticker} only goes back to ${formatDate(first.date)}, so its all-time high isn't known.`;
      } else {
        const top = bars.slice(0, end + 1).reduce((a, b) => (b.high > a.high ? b : a));
        evidence.high = { price: top.high, date: top.date, scope: 'history', complete };
        const yearAgo = addDays(e.date, -365);
        if (claim.reference === 'high' && first.date <= yearAgo) {
          const top52 = bars.slice(0, end + 1).filter((b) => b.date > yearAgo).reduce((a, b) => (b.high > a.high ? b : a));
          if (top52.high < top.high) evidence.high52 = { price: top52.high, date: top52.date, scope: '52_week', complete: true };
        }
      }
    }
  } else if (claim.claimedPercent !== null || claim.direction !== null) {
    const span = spanStart(claim, bars, end);
    if ('reason' in span) evidence.unavailable = span.reason;
    else {
      evidence.move = {
        label: span.label,
        from: span.from,
        to: { date: e.date, price: e.close },
        percent: pct(e.close, span.from.price),
        lowPercent: pct(e.low, span.from.price),
        highPercent: pct(e.high, span.from.price),
      };
    }
  }
  evidence.figures = figuresFor(evidence);
  return evidence;
}

function figuresFor(e: PriceHistoryEvidence): EvidenceFigure[] {
  const rows: EvidenceFigure[] = [];
  if (e.move) rows.push({ label: `Close, ${formatDate(e.move.from.date)}`, value: formatPrice(e.move.from.price) });
  rows.push({ label: `Close, ${formatDate(e.sessionDate)}`, value: formatPrice(e.session.close) });
  if (e.move) rows.push({ label: 'Change', value: formatSignedPercent(e.move.percent) });
  rows.push({ label: `Range, ${formatDate(e.sessionDate)}`, value: `${formatPrice(e.session.low)} to ${formatPrice(e.session.high)}` });
  if (e.high) {
    const label = e.high.scope === '52_week' ? '52-week high' : e.high.complete ? 'All-time high' : `High since ${formatDate(e.firstDate)}`;
    rows.push({ label: `${label} (${formatDate(e.high.date)})`, value: formatPrice(e.high.price) });
  }
  if (e.extended) {
    rows.push({ label: `${e.extended.kind === 'pre_market' ? 'Pre-market' : 'After-hours'}, last trade`, value: formatPrice(e.extended.last.price) });
  }
  if (e.marketCap) rows.push({ label: 'Market value (est.)', value: formatUsd(e.marketCap) });
  return rows;
}

function within(claimed: number, low: number, high: number): boolean {
  const margin = Math.max(Math.abs(claimed) * PRICE_TOLERANCE, PRICE_MIN_POINTS);
  return claimed >= Math.min(low, high) - margin && claimed <= Math.max(low, high) + margin;
}

/** "closed at $X on Nov 3", or "was at $X on Nov 3" while that session is still trading. */
const closed = (e: PriceHistoryEvidence) => (e.settled ? 'closed at' : 'was at');

const still = (e: PriceHistoryEvidence) => (e.settled ? '' : ' That session is still trading, so the numbers can change.');

/** Pure comparison of a price claim with the history on the post's day. */
export function evaluatePriceHistoryClaim(claim: Claim, e: PriceHistoryEvidence): Evaluation {
  if (e.unavailable) return { verdict: 'cant_check', reason: e.unavailable };
  const name = e.entityName;
  const day = formatDate(e.sessionDate);
  const posted = claim.postedAt && claim.postedAt !== e.sessionDate ? ` The post is from ${formatDate(claim.postedAt)}, so the session before it is used.` : '';

  if (claim.type === 'market_cap') return evaluateCap(claim, e);

  // Pre-market and after-hours.
  if (claim.session && e.extended) {
    const x = e.extended;
    const when = x.kind === 'pre_market' ? 'before the open' : 'after the close';
    const text = `${name} last traded at ${formatPrice(x.last.price)} ${when} on ${day}, ${describeChange(x.percent)} from ${formatPrice(x.base.price)}.${still(e)}`;
    return compareMove(claim, x.percent, x.lowPercent, x.highPercent, e.intraday, text, `traded between ${describeChange(x.lowPercent)} and ${describeChange(x.highPercent)} ${when}`);
  }

  // "Down 30% from its highs".
  if (claim.reference && e.high) {
    const h = e.high;
    const claimed = claim.claimedPercent;
    if (claimed === null) return { verdict: 'cant_check', reason: "The post doesn't say how far from the high, so there is nothing to compare." };
    // "Its high" with no span: the 52-week high counts as well as the all-time one.
    if (e.high52) {
      const h52 = e.high52;
      const below52 = ((h52.price - e.session.close) / h52.price) * 100;
      if (agrees(claimed, below52)) {
        return {
          verdict: 'holds_up',
          reason: `${name} ${closed(e)} ${formatPrice(e.session.close)} on ${day}, ${formatPercentMagnitude(below52)} below its 52-week high of ${formatPrice(h52.price)} on ${formatDate(h52.date)}.${posted}${still(e)}`,
        };
      }
    }
    const below = ((h.price - e.session.close) / h.price) * 100;
    const nearest = ((h.price - e.session.high) / h.price) * 100;
    const farthest = ((h.price - e.session.low) / h.price) * 100;
    const highWords = h.scope === '52_week' ? '52-week high' : h.complete ? 'all-time high' : `highest price since ${formatDate(e.firstDate)}`;
    const text = `${name} ${closed(e)} ${formatPrice(e.session.close)} on ${day}, ${formatPercentMagnitude(below)} below its ${highWords} of ${formatPrice(h.price)} on ${formatDate(h.date)}.${posted}${still(e)}`;
    if (agrees(claimed, below)) return { verdict: 'holds_up', reason: text };
    if (e.intraday && within(claimed, nearest, farthest)) {
      return { verdict: 'holds_up', reason: `${text} It traded ${formatPercentMagnitude(nearest)} to ${formatPercentMagnitude(farthest)} below the high that day, so the post was right during the session.` };
    }
    // An older high than the history covers could explain a bigger drop, never a smaller one.
    if (!h.complete && claimed > (e.intraday ? farthest : below)) {
      return { verdict: 'cant_check', reason: `${text} The post may mean a high from before ${formatDate(e.firstDate)}, which the price history doesn't cover.` };
    }
    if (agrees(claimed, below, PRICE_LOOSE)) return { verdict: 'misleading', reason: `Close, but ${claimed > below ? 'overstated' : 'understated'}. ${text}` };
    return { verdict: 'contradicted', reason: `${text} The post says ${formatPercentMagnitude(claimed)} below the high.` };
  }

  // "Trading at $182" on the post's day.
  if (claim.claimedPercent === null && claim.direction === null) {
    if (claim.claimedAmount === null) return { verdict: 'cant_check', reason: "The post doesn't say how the price moved, so there is nothing to compare." };
    const c = claim.claimedAmount;
    const text = `${name} ${closed(e)} ${formatPrice(e.session.close)} on ${day}, after trading between ${formatPrice(e.session.low)} and ${formatPrice(e.session.high)}.${posted}${still(e)}`;
    const gap = Math.abs(c - e.session.close) / c;
    if (gap <= PRICE_TOLERANCE) return { verdict: 'holds_up', reason: text };
    if (e.intraday && c >= e.session.low * (1 - PRICE_TOLERANCE) && c <= e.session.high * (1 + PRICE_TOLERANCE)) {
      return { verdict: 'holds_up', reason: `${text} ${formatPrice(c)} is within that day's range.` };
    }
    if (gap <= PRICE_LOOSE) return { verdict: 'misleading', reason: `Close, but ${c > e.session.close ? 'overstated' : 'understated'}. ${text}` };
    return { verdict: 'contradicted', reason: `${text} The post says ${formatPrice(c)}.` };
  }

  if (!e.move) return { verdict: 'cant_check', reason: "The price history doesn't cover that span." };
  const m = e.move;
  const text = `${name} ${closed(e)} ${formatPrice(m.to.price)} on ${day}, ${describeChange(m.percent)} ${m.label} (from ${formatPrice(m.from.price)} on ${formatDate(m.from.date)}).${posted}${still(e)}`;
  return compareMove(claim, m.percent, m.lowPercent, m.highPercent, e.intraday, text, `traded between ${describeChange(m.lowPercent)} and ${describeChange(m.highPercent)} on the day`);
}

/** A claimed move against the close, and against the session's range when the post may be from mid-session. */
function compareMove(claim: Claim, percent: number, lowPercent: number, highPercent: number, intraday: boolean, text: string, rangeWords: string): Evaluation {
  const sign = claim.direction === 'down' ? -1 : 1;
  if (claim.claimedPercent === null) {
    const same = Math.sign(percent) === sign || percent === 0;
    const sometime = intraday && (sign > 0 ? highPercent > 0 : lowPercent < 0);
    if (same) return { verdict: 'holds_up', reason: text };
    if (sometime) return { verdict: 'holds_up', reason: `${text} It ${rangeWords}, so the move was real during the session.` };
    return { verdict: 'contradicted', reason: text };
  }
  const claimed = sign * claim.claimedPercent;
  const words = `${claim.bound === 'at_least' ? 'more than ' : claim.bound === 'at_most' ? 'less than ' : ''}${formatPercentMagnitude(claimed)} ${sign < 0 ? 'drop' : 'gain'}`;
  const margin = Math.max(Math.abs(claimed) * PRICE_TOLERANCE, PRICE_MIN_POINTS);
  const best = sign > 0 ? highPercent : lowPercent;

  if (claim.bound === 'at_least') {
    if (sign * percent >= claim.claimedPercent - margin) return { verdict: 'holds_up', reason: text };
    if (intraday && sign * best >= claim.claimedPercent - margin) return { verdict: 'holds_up', reason: `${text} It ${rangeWords}, so the post was right during the session.` };
    return { verdict: 'contradicted', reason: `${text} The post says a ${words}.` };
  }
  if (claim.bound === 'at_most') {
    const ok = sign * percent <= claim.claimedPercent + margin && Math.sign(percent) !== -sign;
    return ok ? { verdict: 'holds_up', reason: text } : { verdict: 'contradicted', reason: `${text} The post says a ${words}.` };
  }
  if (agrees(claimed, percent)) return { verdict: 'holds_up', reason: text };
  if (intraday && within(claimed, lowPercent, highPercent)) {
    return { verdict: 'holds_up', reason: `${text} It ${rangeWords}, so a ${words} was true during the session.` };
  }
  if (Math.sign(percent) === sign && agrees(claimed, percent, PRICE_LOOSE)) {
    return { verdict: 'misleading', reason: `Close, but ${Math.abs(claimed) > Math.abs(percent) ? 'overstated' : 'understated'}. ${text}` };
  }
  return { verdict: 'contradicted', reason: `${text} The post says a ${words}.` };
}

function evaluateCap(claim: Claim, e: PriceHistoryEvidence): Evaluation {
  const claimed = claim.claimedAmount;
  if (claimed === null) return { verdict: 'cant_check', reason: "The post doesn't give a market value to compare." };
  if (!e.marketCap) return { verdict: 'cant_check', reason: `No market value found for ${e.ticker}.` };
  const day = formatDate(e.sessionDate);
  const how = ' (estimated from the current market value and the price change since)';

  if (claim.direction) {
    if (!e.move) return { verdict: 'cant_check', reason: "The post doesn't say over what period, so there is no change in value to compare." };
    const before = e.marketCap / (1 + e.move.percent / 100);
    const change = e.marketCap - before;
    const text = `${e.entityName} ${change < 0 ? 'lost' : 'gained'} about ${formatUsd(Math.abs(change))} in market value ${e.move.label} (${describeChange(e.move.percent)} on a value of about ${formatUsd(e.marketCap)}${how}).${still(e)}`;
    const words = `${formatUsd(claimed)} ${claim.direction === 'down' ? 'wiped out' : 'added'}`;
    if ((claim.direction === 'down') !== change < 0) return { verdict: 'contradicted', reason: `${text} The post says ${words}.` };
    const gap = Math.abs(claimed - Math.abs(change)) / claimed;
    if (gap <= CAP_TIGHT) return { verdict: 'holds_up', reason: text };
    if (gap <= CAP_LOOSE) return { verdict: 'misleading', reason: `Close, but ${claimed > Math.abs(change) ? 'overstated' : 'understated'}. ${text}` };
    return { verdict: 'contradicted', reason: `${text} The post says ${words}.` };
  }

  const text = `${e.entityName} was worth about ${formatUsd(e.marketCap)} ${e.settled ? 'at the close' : 'during the session'} on ${day}${how}.${still(e)}`;
  const b = claim.bound === 'at_least' ? 'more than ' : claim.bound === 'at_most' ? 'less than ' : '';
  if (claim.bound) {
    const ok = claim.bound === 'at_least' ? e.marketCap >= claimed * (1 - CAP_TIGHT) : e.marketCap <= claimed * (1 + CAP_TIGHT);
    return ok ? { verdict: 'holds_up', reason: text } : { verdict: 'contradicted', reason: `${text} The post says ${b}${formatUsd(claimed)}.` };
  }
  const gap = Math.abs(claimed - e.marketCap) / claimed;
  if (gap <= CAP_TIGHT) return { verdict: 'holds_up', reason: text };
  if (gap <= CAP_LOOSE) return { verdict: 'misleading', reason: `Close, but ${claimed > e.marketCap ? 'overstated' : 'understated'}. ${text}` };
  return { verdict: 'contradicted', reason: `${text} The post says ${formatUsd(claimed)}.` };
}

export interface PriceHistorySourceOptions {
  history: PriceHistory;
  /** For company names and market value. Optional. */
  finnhub?: FinnhubClient | null;
  now?: () => Date;
}

export function createPriceHistorySource({ history, finnhub, now = () => new Date() }: PriceHistorySourceOptions): EvidenceSource {
  const shape = (c: Claim) =>
    (c.type === 'price_move' && (c.claimedPercent !== null || c.direction !== null || c.claimedAmount !== null || c.reference !== null || c.session !== null)) ||
    (c.type === 'market_cap' && c.claimedAmount !== null);

  return {
    id: 'price-history',
    // Bars are cached in the history itself; this keeps the newest session fresh.
    ttlMs: 5 * 60 * 1000,

    supports: (claim) => Boolean(claim.ticker) && shape(claim) && needsHistory(claim, newYorkDate(now())),

    // Each claim measures its own span, so the key carries everything that picks it.
    cacheKey: (c) =>
      [
        'price-history',
        c.ticker,
        c.postedAt,
        c.type,
        c.window,
        c.windowDays,
        c.reference,
        c.session,
        c.direction ? 'dir' : '',
        /\bthis week\b/i.test(c.quote) ? 'calweek' : '',
        /\b(?:past|last) month\b|\b30 days\b/i.test(c.quote) ? 'rollmonth' : '',
      ].join(':'),

    emptyReason: (claim) => `No price history found for ${claim.ticker}. It may not trade on a US exchange.`,

    async fetchEvidence(claim): Promise<Evidence | null> {
      if (!claim.ticker) return null;
      const bars = await history.daily(claim.ticker);
      if (!bars || bars.length === 0) return null;
      const today = newYorkDate(now());
      const end = lastOnOrBefore(bars, claim.postedAt ?? today);
      const sessionDate = bars[Math.max(end, 0)]!.date;

      const [intraday, profile] = await Promise.all([
        claim.session ? history.intraday(claim.ticker, sessionDate) : Promise.resolve(undefined),
        finnhub ? finnhub.profile(claim.ticker).catch(() => null) : Promise.resolve(null),
      ]);
      const capMillions = typeof profile?.marketCapitalization === 'number' && profile.marketCapitalization > 0 ? profile.marketCapitalization : null;
      return measureHistory(claim, bars, {
        today,
        intraday,
        marketCap: capMillions === null ? null : capMillions * 1e6,
        entityName: profile?.name || claim.ticker,
        label: history.label(),
      });
    },

    evaluate(claim, evidence) {
      if (evidence.kind !== 'price_history') return { verdict: 'cant_check', reason: 'The data found does not match this claim.' };
      return evaluatePriceHistoryClaim(claim, evidence);
    },
  };
}

