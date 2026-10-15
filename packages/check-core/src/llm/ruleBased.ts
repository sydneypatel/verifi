import type { Direction, ExtractedClaim, Metric, Quarter } from '../types';
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

const UNITS: Record<string, number> = { trillion: 1e12, t: 1e12, billion: 1e9, bn: 1e9, b: 1e9, million: 1e6, mn: 1e6, m: 1e6 };
const MULTIPLES: Record<string, number> = { doubled: 100, tripled: 200, quadrupled: 300, doubling: 100, tripling: 200 };
const DOWN = new RegExp(`^(?:${DOWN_WORDS}|drop)$`, 'i');

const AT_LEAST = /\b(more than|over|at least|above|north of)\s*(?:\$)?\d|more than (doubl|tripl|quadrupl)/i;
const AT_MOST = /\b(less than|under|at most|below)\s*(?:\$)?\d/i;
function boundOf(fragment: string): 'at_least' | 'at_most' | null {
  return AT_LEAST.test(fragment) ? 'at_least' : AT_MOST.test(fragment) ? 'at_most' : null;
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
