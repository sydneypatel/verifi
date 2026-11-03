import type { Direction, EstimateResult, ExtractedClaim, Metric, PriceWindow, Quarter } from '../types';
import { normalizeTicker } from './normalize';
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
const PREDICTION = /(?:→|->)\s*\$\d|\b(?:must|strong) buy\b|\$\d+(?:\.\d+)?\s+(?:stock|target|price target|by)\b|\bprice target\b|\bto the moon\b|\bwill (?:hit|reach|double|triple|moon|10x)\b|\bgoing to \$\d+/i;

// "$11.5B", "$42 million". Captures the number and the unit.
const AMOUNT = '\\$(\\d+(?:\\.\\d+)?)\\s?(trillion|billion|million|bn|mn|[TBM])\\b';
const LINK = '(?:\\s+(?:of|was|were|hit|reached|totaled|came in at))?\\s+';
const REVENUE_THEN_AMOUNT = new RegExp(`\\b(?:revenue|revenues|sales)${LINK}${AMOUNT}`, 'i');
const AMOUNT_THEN_REVENUE = new RegExp(`${AMOUNT}\\s+(?:in|of)\\s+(?:\\w+\\s+){0,2}?(?:revenue|revenues|sales)\\b`, 'i');
const NET_THEN_AMOUNT = new RegExp(`\\bnet (loss|income|profit)${LINK}${AMOUNT}`, 'i');
const AMOUNT_THEN_NET = new RegExp(`${AMOUNT}\\s+(?:in\\s+)?net (loss|income|profit)\\b`, 'i');

// "$NVDA is up 12% today", "shares fell 30% this year", "the stock doubled".
const MOVE_WORDS = `${UP_WORDS}|${DOWN_WORDS}|gained|gain|lost|rallied|ripped|ran|tanked|dumped|plunged|crashed|popped|spiked`;
const PRICE_MOVE = new RegExp(
  `(?:\\$[A-Za-z]{1,5}|\\b(?:stock|shares|share price|price)\\b)[^.!?\\n%$]{0,30}?\\b(${MOVE_WORDS})\\b\\s*(?:by\\s+)?(?:(?:over|more than|almost|nearly)\\s+)?(\\d+(?:\\.\\d+)?)\\s?%`,
  'i',
);
const PRICE_MULTIPLE = /(?:\$[A-Za-z]{1,5}|\b(?:stock|shares)\b)[^.!?\n$]{0,20}?\b(doubled|tripled|halved)\b/i;
// Words that mean the "up 40%" is about a business number, not the share price.
const NOT_PRICE = /\b(revenue|revenues|sales|earnings|eps|income|profit|margin|users|short interest)\b/i;

const MARKET_CAP_THEN_AMOUNT = new RegExp(`\\bmarket (?:cap|capitalization|value)\\b[^.!?\\n$]{0,20}?${AMOUNT}`, 'i');
const AMOUNT_THEN_MARKET_CAP = new RegExp(`${AMOUNT}\\s+(?:market cap|market value|company)\\b`, 'i');

// "crushed earnings", "missed estimates", "EPS of $1.25", "$0.45 a share".
const VS_ESTIMATE =
  /\b(beat|beats|crushed|crushes|smashed|smashes|topped|tops|blew past|blew out|missed|misses|met|meets|matched)\b[^.!?\n]{0,25}?\b(earnings|estimates|expectations|eps|consensus|the street)\b|\b(?:earnings|eps)\s+(beat|miss)\b/i;
const EPS_AMOUNT = /\bEPS\b(?:\s+(?:of|was|came in at|at|hit))?\s+(-)?\$?(\d+(?:\.\d+)?)|(-)?\$(\d+(?:\.\d+)?)\s+(?:a|per)\s+share\b|\b(\d+)\s?cents?\s+(?:a|per)\s+share\b/i;

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

function estimateOf(word: string): EstimateResult {
  const w = word.toLowerCase();
  if (w.startsWith('miss')) return 'miss';
  if (w === 'met' || w === 'meets' || w === 'matched') return 'in_line';
  return 'beat';
}

function periodOf(sentence: string): 'quarter' | 'year' | null {
  if (/\b(quarter|q[1-4]|qoq)\b/i.test(sentence)) return 'quarter';
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
      const sentences = postText
        .split(/(?<=[.!?])\s+|\n+/)
        .map((s) => s.trim())
        .filter(Boolean);

      const claims: ExtractedClaim[] = [];

      for (const sentence of sentences) {
        // A sentence's own cashtag wins; otherwise the post's, if it names only one.
        const base = { ...EMPTY_CLAIM, ticker: normalizeTicker(sentence.match(/\$([A-Za-z]{1,5})\b/)?.[1]) ?? postTicker };
        let matched = false;
        const period = periodOf(sentence);
        const year = sentence.match(/\b(20\d{2})\b/)?.[1];
        const quarter = sentence.match(/\bQ([1-4])\b/i)?.[1];

        // "revenue is up 40%"
        const revenue = sentence.match(REVENUE_PERCENT);
        const flipped = sentence.match(PERCENT_REVENUE_GROWTH);
        const multiple = sentence.match(REVENUE_MULTIPLE);
        if (revenue) {
          const direction: Direction = DOWN.test(revenue[1]!) ? 'down' : 'up';
          claims.push({ ...base, quote: revenue[0].trim(), type: 'revenue_growth', claimedPercent: Number(revenue[2]), direction, period, bound: boundOf(revenue[0]) });
          matched = true;
        } else if (flipped) {
          const direction: Direction = DOWN.test(flipped[2]!) ? 'down' : 'up';
          claims.push({ ...base, quote: flipped[0].trim(), type: 'revenue_growth', claimedPercent: Number(flipped[1]), direction, period });
          matched = true;
        } else if (multiple) {
          claims.push({ ...base, quote: multiple[0].trim(), type: 'revenue_growth', claimedPercent: MULTIPLES[multiple[1]!.toLowerCase()] ?? null, direction: 'up', period, bound: boundOf(multiple[0]) });
          matched = true;
        }

        // "revenue of $48M", "$4.6B of 2025 revenue", "a $42B net loss"
        const figure = (quote: string, metric: Metric, amount: number) => {
          claims.push({
            ...base,
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

        // "$NVDA is up 12% today": the share price, unless the sentence is about a business number.
        if (!revenue && !flipped && !multiple) {
          const move = sentence.match(PRICE_MOVE);
          const doubled = sentence.match(PRICE_MULTIPLE);
          if (move && !NOT_PRICE.test(move[0])) {
            const direction: Direction = DOWN.test(move[1]!) || /^(lost|tanked|dumped|plunged|crashed)$/i.test(move[1]!) ? 'down' : 'up';
            claims.push({ ...base, quote: move[0].trim(), type: 'price_move', claimedPercent: Number(move[2]), direction, window: windowOf(sentence), bound: boundOf(move[0]) });
            matched = true;
          } else if (doubled && !NOT_PRICE.test(doubled[0])) {
            const word = doubled[1]!.toLowerCase();
            claims.push({
              ...base,
              quote: doubled[0].trim(),
              type: 'price_move',
              claimedPercent: word === 'halved' ? 50 : (MULTIPLES[word] ?? null),
              direction: word === 'halved' ? 'down' : 'up',
              window: windowOf(sentence),
            });
            matched = true;
          }
        }

        // "a $3T company", "market cap of $50B"
        const capA = sentence.match(MARKET_CAP_THEN_AMOUNT);
        const capB = sentence.match(AMOUNT_THEN_MARKET_CAP);
        const cap = capA ?? capB;
        if (cap) {
          claims.push({ ...base, quote: cap[0].trim(), type: 'market_cap', claimedAmount: dollars(cap[1]!, cap[2]!), bound: boundOf(cap[0]) });
          matched = true;
        }

        // "crushed earnings", "EPS of $1.25": one earnings claim per sentence.
        // "Revenue beat estimates" is about revenue, not earnings per share.
        const vsRaw = sentence.match(VS_ESTIMATE);
        const vs = vsRaw && /\b(revenue|revenues|sales)\b[^.!?\n]{0,15}$/i.test(sentence.slice(0, vsRaw.index)) ? null : vsRaw;
        const eps = sentence.match(EPS_AMOUNT);
        if (vs || eps) {
          const spans = [vs, eps].filter((m): m is RegExpMatchArray => Boolean(m));
          const start = Math.min(...spans.map((m) => m.index!));
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

        if (!matched && PREDICTION.test(sentence)) {
          claims.push({ ...base, quote: sentence.replace(/[.!?]+$/, ''), type: 'prediction' });
        }
      }

      return claims;
    },
  };
}
