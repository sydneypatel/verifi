import type { Comparison, Direction, EstimateResult, ExtractedClaim, Metric, PriceReference, PriceWindow, Quarter, Session } from '../types';
import { isPersonal, normalizeClaims, normalizeTicker } from './normalize';
import { EMPTY_CLAIM, type ClaimExtractor } from './types';

// A no-key fallback so the whole pipeline runs without an LLM: in tests, in
// the offline demo, and when the API key is missing. It only understands a few
// common phrasings. The LLM extractor is what handles real, messy posts.

const UP_WORDS = 'up|grew|grow|growth|increase|increased|jumped|jump|rose|surged|soared|climbed';
const DOWN_WORDS = 'down|fell|dropped|declined|decline|decreased|decrease|shrank|slid';

const REVENUE_PERCENT = new RegExp(
  `\\b(?:revenue|revenues|sales)\\b[^.!?\\n]{0,60}?\\b(${UP_WORDS}|${DOWN_WORDS})\\b[^.!?\\n%]{0,25}?(\\d+(?:\\.\\d+)?)\\s?%`,
  'i',
);
const PERCENT_REVENUE_GROWTH = /(\d+(?:\.\d+)?)\s?%\s+(?:revenue|sales)\s+(growth|increase|decline|drop)/i;
const REVENUE_MULTIPLE = /\b(?:revenue|revenues|sales)\b[^.!?\n]{0,40}?\b(doubled|tripled|quadrupled|doubling|tripling)\b/i;
const SHORT_INTEREST = /\bshort interest\b[^.!?\n]{0,60}?(\d+(?:\.\d+)?)\s?%[^.!?\n,;]*/i;
const PREDICTION = /(?:→|->)\s*\$\d|\b\d+(?:\.\d+)?\s?%\s+upside\b|\bupside (?:of|to)\b|\b(?:must|strong) buy\b|\$\d+(?:\.\d+)?\s+(?:stock|target|price target|by)\b|\bprice target\b|\bto the moon\b|\bwill (?:hit|reach|double|triple|moon|10x)\b|\bgoing to \$\d+/i;

// "$11.5B", "$42 million". Captures the number and the unit.
const AMOUNT = '\\$(\\d+(?:\\.\\d+)?)\\s?(trillion|billion|million|bn|mn|[TBM])\\b';
const LINK = '(?:\\s+(?:of|was|were|hit|reached|totaled|came in at)|\\s*:)?\\s+';
const REVENUE_THEN_AMOUNT = new RegExp(`\\b(?:revenue|revenues|sales)${LINK}${AMOUNT}`, 'i');
const AMOUNT_THEN_REVENUE = new RegExp(`${AMOUNT}\\s+(?:in|of)\\s+(?:\\w+\\s+){0,2}?(?:revenue|revenues|sales)\\b`, 'i');
const NET_THEN_AMOUNT = new RegExp(`\\bnet (loss|income|profit)${LINK}${AMOUNT}`, 'i');
const AMOUNT_THEN_NET = new RegExp(`${AMOUNT}\\s+(?:in\\s+)?net (loss|income|profit)\\b`, 'i');
const OPERATING_THEN_AMOUNT = new RegExp(`\\boperating (loss|income|profit)${LINK}${AMOUNT}`, 'i');
const AMOUNT_THEN_OPERATING = new RegExp(`${AMOUNT}\\s+(?:in\\s+)?(?:of\\s+)?operating (loss|income|profit)\\b`, 'i');

// One business line, not the company: "AI Cloud revenue", "Azure grew 40%", "ad revenue".
const NAMED_SEGMENT = '(?:AI Cloud|Azure|AWS|Google Cloud|Microsoft Cloud|Intelligent Cloud|YouTube|iPhone|data ?cent(?:er|re))';
const SEGMENT_BEFORE_REVENUE = new RegExp(
  `\\b(${NAMED_SEGMENT}|ad|ads|advertising|cloud|services|gaming|automotive|subscription|segment)\\s+(?:revenue|revenues|sales)\\b`,
  'i',
);
const SEGMENT_GROWTH = new RegExp(
  `\\b(${NAMED_SEGMENT})\\b[^.!?\\n%]{0,30}?\\b(${'up|grew|grow|growth|increased|jumped|rose|surged|soared|climbed|down|fell|dropped|declined'})\\b[^.!?\\n%]{0,15}?(\\d+(?:\\.\\d+)?)\\s?%`,
  'i',
);
const EPS_GROWTH = new RegExp(`\\b(?:eps|earnings per share)\\b[^.!?\\n%]{0,20}?\\b(${UP_WORDS}|${DOWN_WORDS})\\b[^.!?\\n%]{0,15}?(\\d+(?:\\.\\d+)?)\\s?%`, 'i');

// "$NVDA is up 12% today", "shares fell 30% this year", "the stock doubled".
const MOVE_WORDS = `${UP_WORDS}|${DOWN_WORDS}|gained|gain|lost|rallied|ripped|ran|tanked|dumped|plunged|crashed|popped|spiked`;
const PRICE_MOVE = new RegExp(
  `(?:\\$[A-Za-z]{1,5}|\\b(?:stock|shares|share price|price)\\b)[^.!?\\n%$]{0,30}?\\b(${MOVE_WORDS})\\b\\s*(?:by\\s+)?(?:(?:over|more than|almost|nearly)\\s+)?(\\d+(?:\\.\\d+)?)\\s?%`,
  'i',
);
const PRICE_MULTIPLE = /(?:\$[A-Za-z]{1,5}|\b(?:stock|shares)\b)[^.!?\n$]{0,20}?\b(doubled|tripled|halved)\b/i;
// Words that mean the "up 40%" is about a business number, not the share price.
const NOT_PRICE = /\b(revenue|revenues|sales|earnings|eps|income|profit|margin|users|short interest)\b/i;

// "$500B wiped out", "erased $1T", "added $200B in market value".
const CAP_CHANGE = new RegExp(
  `${AMOUNT}\\s+(?:in market (?:value|cap)\\s+|of (?:market )?value\\s+)?(wiped out|wiped off|erased|lost|vanished|added|gained)|\\b(wiped|erased|lost|added|gained)\\s+(?:out\\s+|off\\s+)?${AMOUNT}`,
  'i',
);
// "trading at $182", "closed at $65.78", "shares at $40".
const CURRENT_PRICE = /(?:\$[A-Za-z]{1,5}|\b(?:stock|shares|it))\b[^.!?\n$]{0,20}?\b(?:trading at|trades at|closed at|at|now)\s+\$(\d+(?:\.\d+)?)(?!\s?(?:trillion|billion|million|bn|mn|[TBMK])\b)(?!\s+(?:stock|target|price target|by))/i;

const MARKET_CAP_THEN_AMOUNT = new RegExp(`\\bmarket (?:cap|capitalization|value)\\b[^.!?\\n$]{0,20}?${AMOUNT}`, 'i');
const AMOUNT_THEN_MARKET_CAP = new RegExp(`${AMOUNT}\\s+(?:market cap|market value|company)\\b`, 'i');

// "crushed earnings", "missed estimates", "EPS of $1.25", "$0.45 a share".
const VS_ESTIMATE =
  /\b(beat|beats|crushed|crushes|smashed|smashes|topped|tops|blew past|blew out|missed|misses|met|meets|matched)\b[^.!?\n]{0,25}?\b(earnings|estimates|expectations|eps|consensus|the street)\b|\b(?:earnings|eps)\s+(beat|miss)\b/i;
const EPS_AMOUNT = /\bEPS\b(?:\s+(?:of|was|came in at|at|hit)|\s*:)?\s+(-)?\$?(\d+(?:\.\d+)?)|(-)?\$(\d+(?:\.\d+)?)\s+(?:a|per)\s+share\b|\b(\d+)\s?cents?\s+(?:a|per)\s+share\b/i;

// "The expectations are:", "consensus", "analysts expect": the figures that follow are the Street's, not reported.
const ESTIMATE_CONTEXT = /\b(?:expectations?|expected|consensus|estimates? (?:are|is|of|for)|the street (?:expects|is looking for)|analysts? (?:expect|see|are looking for)|wall street expects)\b/i;
const NOT_ESTIMATE = /\b(?:beat|beats|missed|misses|topped|crushed|came in|reported)\b/i;
// "reports earnings today after close", "earnings Thursday before the open".
const EARNINGS_DATE = /\b(?:reports?|reporting|releases?)\s+(?:its\s+)?(?:q[1-4]\s+)?(?:earnings|results|numbers)\b[^.!?\n]{0,40}|\bearnings\s+(?:are\s+|come\s+out\s+)?(?:today|tomorrow|tonight|on\s+\w+|this week|next week|(?:mon|tues|wednes|thurs|fri)day)\b[^.!?\n]{0,30}/i;
const EVENT_DAY = /\b(today|tonight|tomorrow|this week|next week|(?:mon|tues|wednes|thurs|fri)day|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2})\b/i;
const IMPLIED_MOVE = /\bimplied move\b[^.!?\n%]{0,20}?(\d+(?:\.\d+)?)\s?%|\boptions (?:are )?pricing (?:in )?(?:a )?(\d+(?:\.\d+)?)\s?% move/i;

const UNITS: Record<string, number> = { trillion: 1e12, t: 1e12, billion: 1e9, bn: 1e9, b: 1e9, million: 1e6, mn: 1e6, m: 1e6 };
const MULTIPLES: Record<string, number> = { doubled: 100, tripled: 200, quadrupled: 300, doubling: 100, tripling: 200 };
const DOWN = new RegExp(`^(?:${DOWN_WORDS}|drop)$`, 'i');

const AT_LEAST = /\b(more than|over|at least|above|north of)\s*(?:\$)?\d|more than (doubl|tripl|quadrupl)/i;
const AT_MOST = /\b(less than|under|at most|below)\s*(?:\$)?\d/i;
function boundOf(fragment: string): 'at_least' | 'at_most' | null {
  return AT_LEAST.test(fragment) ? 'at_least' : AT_MOST.test(fragment) ? 'at_most' : null;
}

function windowOf(sentence: string): PriceWindow | null {
  if (/\b(today|this morning|this session|intraday|on the day)\b/i.test(sentence)) return 'day';
  if (/\b(this week|past week|last week|5 days|five days)\b/i.test(sentence)) return 'week';
  if (/\b(this month|past month|month to date|mtd)\b/i.test(sentence)) return 'month';
  if (/\b(this year|ytd|year to date)\b/i.test(sentence)) return 'ytd';
  if (/\b(past year|last year|12 months|twelve months|52[- ]weeks?|one year|1 year)\b/i.test(sentence)) return 'year';
  return null;
}

/** "48 hours" is 2 days, "3 years" 1095, "since IPO" a span longer than any the data has. */
function windowDaysOf(sentence: string): number | null {
  if (/\b(since (?:the )?ipo|all[- ]time|ever|since inception)\b/i.test(sentence) && !/\ball[- ]time high\b/i.test(sentence)) return 36500;
  const m = sentence.match(/\b(?:past|last|in|over)?\s*(\d+)\s?(hours?|hrs?|days?|weeks?|months?|years?|yrs?)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (unit.startsWith('h')) return n % 24 === 0 && n > 24 ? n / 24 : null;
  if (unit.startsWith('d')) return n === 1 ? null : n;
  if (unit.startsWith('w')) return n === 1 || n === 52 ? null : n * 7;
  if (unit.startsWith('m')) return n === 12 || n === 1 ? null : n * 30;
  return n === 1 ? null : n * 365;
}

function sessionOf(sentence: string): Session | null {
  if (/\bpre[- ]?market\b/i.test(sentence)) return 'pre_market';
  if (/\b(after[- ]hours|afterhours|extended[- ]hours|overnight)\b/i.test(sentence)) return 'after_hours';
  return null;
}

function referenceOf(sentence: string): PriceReference | null {
  if (/\bfrom (?:its |the )?(?:all[- ]time high|ath|record high)s?\b/i.test(sentence)) return 'high_all_time';
  if (/\bfrom (?:its |the )?52[- ]week highs?\b/i.test(sentence)) return 'high_52_week';
  if (/\b(?:from|off) (?:its |the )?(?:highs?|peak|top)\b/i.test(sentence)) return 'high';
  return null;
}

function comparisonOf(sentence: string): Comparison | null {
  if (/\b(qoq|q\/q|quarter[- ]over[- ]quarter|sequentially|vs\.? (?:the )?(?:last|prior|previous) quarter)\b/i.test(sentence)) return 'qoq';
  if (/\b(yoy|y\/y|year[- ]over[- ]year|vs\.? (?:a year ago|last year))\b/i.test(sentence)) return 'yoy';
  return null;
}

function segmentOf(sentence: string): string | null {
  return sentence.match(SEGMENT_BEFORE_REVENUE)?.[1] ?? null;
}

function estimateMetric(span: string): Metric {
  if (/\b(eps|earnings)\b/i.test(span)) return 'eps';
  if (/\b(revenue|revenues|sales|top line)\b/i.test(span)) return 'revenue';
  if (/\b(guidance|outlook|forecast)\b/i.test(span)) return 'guidance';
  if (/\bfree cash flow|fcf\b/i.test(span)) return 'free_cash_flow';
  return 'eps';
}

function estimateOf(word: string): EstimateResult {
  const w = word.toLowerCase();
  if (w.startsWith('miss')) return 'miss';
  if (w === 'met' || w === 'meets' || w === 'matched') return 'in_line';
  return 'beat';
}

function periodOf(sentence: string): 'quarter' | 'year' | null {
  if (/\b(quarter|q[1-4]|qoq|q\/q|sequentially)\b/i.test(sentence)) return 'quarter';
  if (/\b(annual|full[- ]year|fiscal year|yearly|fy\s?\d{2,4})\b/i.test(sentence)) return 'year';
  return null;
}

function dollars(number: string, unit: string): number {
  return Number(number) * (UNITS[unit.toLowerCase()] ?? 1);
}

export function createRuleBasedExtractor(): ClaimExtractor {
  return {
    name: 'rule-based',

    async extractClaims(postText: string): Promise<ExtractedClaim[]> {
      const cashtags = [...new Set([...postText.matchAll(/\$([A-Za-z]{1,5})\b/g)].map((m) => normalizeTicker(m[1])).filter(Boolean))];
      const postTicker = cashtags.length === 1 ? cashtags[0]! : null;
      // Sentences, lines, and the items of a list ("•", ";", " | ") are read one by one.
      const sentences = postText
        .split(/(?<=[.!?])\s+|\n+|;\s*|\s+\|\s+|\s*[•·▪]\s+/)
        .map((s) => s.trim())
        .filter(Boolean);

      const claims: ExtractedClaim[] = [];
      // Sentences left in which figures are the Street's expectations.
      let estimateLines = 0;

      for (const sentence of sentences) {
        const before = claims.length;
        if (ESTIMATE_CONTEXT.test(sentence) && !NOT_ESTIMATE.test(sentence)) estimateLines = 5;
        // A sentence's own cashtag wins; otherwise the post's, if it names only one.
        const base = { ...EMPTY_CLAIM, ticker: normalizeTicker(sentence.match(/\$([A-Za-z]{1,5})\b/)?.[1]) ?? postTicker };
        let matched = false;
        const period = periodOf(sentence);
        const comparison = comparisonOf(sentence);
        const segment = segmentOf(sentence);
        const year = sentence.match(/\b(20\d{2})\b/)?.[1];
        const quarter = sentence.match(/\bQ([1-4])\b/i)?.[1];

        // "revenue is up 40%"
        const revenue = sentence.match(REVENUE_PERCENT);
        const flipped = sentence.match(PERCENT_REVENUE_GROWTH);
        const multiple = sentence.match(REVENUE_MULTIPLE);
        const segmentMove = sentence.match(SEGMENT_GROWTH);
        const growth = { period, comparison, segment, fiscalYear: year ? Number(year) : null, fiscalQuarter: quarter ? (Number(quarter) as Quarter) : null };
        // The quote starts at the segment name, so "AI Cloud revenue" is part of it.
        const fromSegment = (m: RegExpMatchArray) => {
          const at = segment ? sentence.toLowerCase().indexOf(segment.toLowerCase()) : -1;
          return at !== -1 && at < m.index! ? sentence.slice(at, m.index! + m[0].length).trim() : m[0].trim();
        };
        if (revenue) {
          const direction: Direction = DOWN.test(revenue[1]!) ? 'down' : 'up';
          claims.push({ ...base, ...growth, quote: fromSegment(revenue), type: 'revenue_growth', claimedPercent: Number(revenue[2]), direction, bound: boundOf(revenue[0]) });
          matched = true;
        } else if (flipped) {
          const direction: Direction = DOWN.test(flipped[2]!) ? 'down' : 'up';
          claims.push({ ...base, ...growth, quote: fromSegment(flipped), type: 'revenue_growth', claimedPercent: Number(flipped[1]), direction });
          matched = true;
        } else if (multiple) {
          claims.push({ ...base, ...growth, quote: fromSegment(multiple), type: 'revenue_growth', claimedPercent: MULTIPLES[multiple[1]!.toLowerCase()] ?? null, direction: 'up', bound: boundOf(multiple[0]) });
          matched = true;
        } else if (segmentMove) {
          // "Azure grew 40%": a business line's revenue, named without the word "revenue".
          const direction: Direction = DOWN.test(segmentMove[2]!) ? 'down' : 'up';
          claims.push({ ...base, ...growth, segment: segmentMove[1]!, quote: segmentMove[0].trim(), type: 'revenue_growth', claimedPercent: Number(segmentMove[3]), direction });
          matched = true;
        }

        // "revenue of $48M", "$4.6B of 2025 revenue", "a $42B net loss"
        const figure = (quote: string, metric: Metric, amount: number) => {
          claims.push({
            ...base,
            segment: metric === 'revenue' ? segment : null,
            bound: boundOf(quote),
            quote: quote.trim(),
            type: 'financial_figure',
            metric,
            claimedAmount: amount,
            period: quarter ? 'quarter' : period ?? (year ? 'year' : null),
            fiscalYear: year ? Number(year) : null,
            fiscalQuarter: quarter ? (Number(quarter) as Quarter) : null,
          });
          matched = true;
        };
        const revA = sentence.match(REVENUE_THEN_AMOUNT);
        const revB = sentence.match(AMOUNT_THEN_REVENUE);
        if (revA) figure(revA[0], 'revenue', dollars(revA[1]!, revA[2]!));
        else if (revB) figure(revB[0], 'revenue', dollars(revB[1]!, revB[2]!));

        const netA = sentence.match(NET_THEN_AMOUNT);
        const netB = sentence.match(AMOUNT_THEN_NET);
        if (netA) figure(netA[0], 'net_income', dollars(netA[2]!, netA[3]!) * (netA[1]!.toLowerCase() === 'loss' ? -1 : 1));
        else if (netB) figure(netB[0], 'net_income', dollars(netB[1]!, netB[2]!) * (netB[3]!.toLowerCase() === 'loss' ? -1 : 1));

        // Operating income is its own line, never net income.
        const opA = sentence.match(OPERATING_THEN_AMOUNT);
        const opB = sentence.match(AMOUNT_THEN_OPERATING);
        if (opA) figure(opA[0], 'operating_income', dollars(opA[2]!, opA[3]!) * (opA[1]!.toLowerCase() === 'loss' ? -1 : 1));
        else if (opB) figure(opB[0], 'operating_income', dollars(opB[1]!, opB[2]!) * (opB[3]!.toLowerCase() === 'loss' ? -1 : 1));

        // "$NVDA is up 12% today": the share price, unless the sentence is about a business number.
        const priceTiming = { window: windowOf(sentence), windowDays: windowDaysOf(sentence), session: sessionOf(sentence), reference: referenceOf(sentence) };
        const capChange = sentence.match(CAP_CHANGE);
        if (!revenue && !flipped && !multiple && !segmentMove && !capChange) {
          const move = sentence.match(PRICE_MOVE);
          const doubled = sentence.match(PRICE_MULTIPLE);
          const price = sentence.match(CURRENT_PRICE);
          if (move && !NOT_PRICE.test(move[0])) {
            const direction: Direction = DOWN.test(move[1]!) || /^(lost|tanked|dumped|plunged|crashed)$/i.test(move[1]!) ? 'down' : 'up';
            // Keep "from its highs" and "after hours" in the quote when they follow the number.
            const tail = sentence.slice(move.index! + move[0].length).match(/^\s*(?:from (?:its |the )?(?:all[- ]time |52[- ]week |record )?(?:highs?|peak|ath)|in (?:pre[- ]?market|after[- ]hours)(?: trading)?|after[- ]hours|pre[- ]?market)/i)?.[0] ?? '';
            claims.push({ ...base, ...priceTiming, quote: (move[0] + tail).trim(), type: 'price_move', claimedPercent: Number(move[2]), direction, bound: boundOf(move[0]) });
            matched = true;
          } else if (doubled && !NOT_PRICE.test(doubled[0])) {
            const word = doubled[1]!.toLowerCase();
            claims.push({
              ...base,
              quote: doubled[0].trim(),
              type: 'price_move',
              claimedPercent: word === 'halved' ? 50 : (MULTIPLES[word] ?? null),
              direction: word === 'halved' ? 'down' : 'up',
              ...priceTiming,
            });
            matched = true;
          } else if (price && !NOT_PRICE.test(price[0])) {
            claims.push({ ...base, ...priceTiming, quote: price[0].trim(), type: 'price_move', claimedAmount: Number(price[1]) });
            matched = true;
          }
        }

        // "$500B wiped out": a change in market value, checked as the move times the value.
        if (capChange) {
          const number = capChange[1] ?? capChange[5]!;
          const unit = capChange[2] ?? capChange[6]!;
          const word = (capChange[3] ?? capChange[4]!).toLowerCase();
          const direction: Direction = /^(added|gained)$/.test(word) ? 'up' : 'down';
          claims.push({ ...base, quote: capChange[0].trim(), type: 'market_cap', claimedAmount: dollars(number, unit), direction, window: windowOf(sentence), windowDays: windowDaysOf(sentence) });
          matched = true;
        }

        // "a $3T company", "market cap of $50B"
        const capA = sentence.match(MARKET_CAP_THEN_AMOUNT);
        const capB = sentence.match(AMOUNT_THEN_MARKET_CAP);
        const cap = capChange ? null : (capA ?? capB);
        if (cap) {
          claims.push({ ...base, quote: cap[0].trim(), type: 'market_cap', claimedAmount: dollars(cap[1]!, cap[2]!), bound: boundOf(cap[0]) });
          matched = true;
        }

        // "crushed earnings", "EPS of $1.25": one earnings claim per sentence.
        // "Revenue beat estimates" is about revenue, not earnings per share.
        const vs = sentence.match(VS_ESTIMATE);
        // "Revenue beat estimates": a beat on revenue, which EPS can't prove.
        const vsMetric = vs ? (/\b(eps|earnings)\b/i.test(vs[0]) ? 'eps' : estimateMetric(sentence.slice(Math.max(0, vs.index! - 12), vs.index! + vs[0].length))) : 'eps';
        const eps = sentence.match(EPS_AMOUNT);
        const epsGrowth = vs || eps ? null : sentence.match(EPS_GROWTH);
        if (epsGrowth) {
          // "EPS up 40% YoY" is growth, not a beat.
          const direction: Direction = DOWN.test(epsGrowth[1]!) ? 'down' : 'up';
          claims.push({ ...base, quote: epsGrowth[0].trim(), type: 'earnings_result', metric: 'eps', claimedPercent: Number(epsGrowth[2]), direction, comparison, period });
          matched = true;
        }
        if (vs || eps) {
          const spans = [vs, eps].filter((m): m is RegExpMatchArray => Boolean(m));
          let start = Math.min(...spans.map((m) => m.index!));
          // "Revenue beat estimates": keep the measure in the quote.
          if (vs && vsMetric !== 'eps') {
            const before = sentence.slice(Math.max(0, vs.index! - 12), vs.index!);
            const at = before.search(/\b(revenue|revenues|sales|top line|guidance|outlook|forecast|free cash flow|fcf)\b/i);
            if (at !== -1) start = Math.min(start, Math.max(0, vs.index! - 12) + at);
          }
          const end = Math.max(...spans.map((m) => m.index! + m[0].length));
          let perShare: number | null = null;
          if (eps) {
            perShare = eps[2] ? Number(eps[2]) : eps[4] ? Number(eps[4]) : Number(eps[5]) / 100;
            if (eps[1] || eps[3] || /\bloss\b/i.test(sentence)) perShare = -Math.abs(perShare);
          }
          claims.push({
            ...base,
            quote: sentence.slice(start, end).trim(),
            type: 'earnings_result',
            metric: vsMetric,
            vsEstimate: vs ? estimateOf(vs[1] ?? vs[3]!) : null,
            claimedAmount: perShare,
            period: quarter ? 'quarter' : null,
            fiscalYear: year ? Number(year) : null,
            fiscalQuarter: quarter ? (Number(quarter) as Quarter) : null,
          });
          matched = true;
        }

        const short = sentence.match(SHORT_INTEREST);
        if (short) {
          claims.push({ ...base, quote: short[0].trim(), type: 'short_interest', claimedPercent: Number(short[1]) });
          matched = true;
        }

        const implied = sentence.match(IMPLIED_MOVE);
        if (implied) {
          claims.push({ ...base, quote: implied[0].trim(), type: 'implied_move', claimedPercent: Number(implied[1] ?? implied[2]) });
          matched = true;
        }

        const reports = sentence.match(EARNINGS_DATE);
        if (reports && (EVENT_DAY.test(reports[0]) || /\b(?:after|before)\b/i.test(reports[0]))) {
          const span = reports[0].trim().replace(/[.!?,]+$/, '');
          const session = /\b(?:after (?:the )?(?:close|bell|market)|after[- ]hours|amc)\b/i.test(span)
            ? ('after_hours' as const)
            : /\b(?:before (?:the )?(?:open|bell|market)|pre[- ]?market|bmo)\b/i.test(span)
              ? ('pre_market' as const)
              : null;
          claims.push({ ...base, quote: span, type: 'earnings_date', eventDate: span.match(EVENT_DAY)?.[1] ?? null, session });
          matched = true;
        }

        // After "the expectations are", revenue and EPS figures are consensus estimates.
        if (estimateLines > 0) {
          for (let i = before; i < claims.length; i++) {
            const c = claims[i]!;
            if (c.type === 'financial_figure' && c.metric === 'revenue') claims[i] = { ...c, type: 'consensus_estimate' };
            else if (c.type === 'earnings_result' && c.claimedAmount !== null && !c.vsEstimate) claims[i] = { ...c, type: 'consensus_estimate', metric: 'eps' };
          }
          estimateLines--;
        }

        if (!matched && isPersonal(sentence)) {
          claims.push({ ...base, quote: sentence.replace(/[.!?]+$/, ''), type: 'personal' });
        } else if (!matched && PREDICTION.test(sentence)) {
          claims.push({ ...base, quote: sentence.replace(/[.!?]+$/, ''), type: 'prediction' });
        }
      }

      // The same clean-up as model output: upside targets, personal positions, segments.
      return normalizeClaims(claims);
    },
  };
}
