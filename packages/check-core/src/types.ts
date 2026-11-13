// Shared types for the whole product. The web app, the extension and any
// later native client all render a CheckResult and nothing else.

export type ClaimType =
  | 'revenue_growth'
  | 'financial_figure'
  | 'short_interest'
  | 'corporate_event'
  | 'earnings_result'
  /** What analysts expect a coming report to show: "EPS expected at $4.06", "consensus revenue $10.3B". */
  | 'consensus_estimate'
  /** When a company reports: "reports earnings today after close". */
  | 'earnings_date'
  /** The move the options market prices in for a report. Needs options data. */
  | 'implied_move'
  | 'price_move'
  | 'market_cap'
  | 'prediction'
  | 'opinion'
  /** The poster's own gain or loss ("I'm up 40% on this"). Set aside, never checked. */
  | 'personal'
  | 'other';

export type Verdict = 'holds_up' | 'misleading' | 'contradicted' | 'cant_check';

export type Direction = 'up' | 'down';
export type Period = 'quarter' | 'year';
/** "more than doubled", "over $2B" = at_least; "under 5%" = at_most. */
export type Bound = 'at_least' | 'at_most';
export type Quarter = 1 | 2 | 3 | 4;

/**
 * Which measure a claim is about. Dollar-figure claims use revenue, operating_income,
 * net_income, free_cash_flow or other. Earnings claims use eps (the default), or
 * revenue, guidance or free_cash_flow when the post says those beat or missed.
 */
export type Metric = 'revenue' | 'operating_income' | 'net_income' | 'eps' | 'free_cash_flow' | 'guidance' | 'other';

/** The measures SEC dollar figures are checked for. */
export type FigureMetric = 'revenue' | 'operating_income' | 'net_income';

/** What a growth claim compares: the same period a year earlier, or the period just before. */
export type Comparison = 'yoy' | 'qoq';

/** Price moves outside regular trading hours. */
export type Session = 'pre_market' | 'after_hours';

/** What a price move is measured from: "down 30% from its highs". */
export type PriceReference = 'high_52_week' | 'high_all_time' | 'high';

/** "Beat estimates", "missed", "in line with expectations". */
export type EstimateResult = 'beat' | 'miss' | 'in_line';

/** The time span a stock-price claim is about: "today", "this week", "this year". */
export type PriceWindow = 'day' | 'week' | 'month' | 'ytd' | 'year';

/** One checkable (or uncheckable) statement pulled out of a post. */
export interface Claim {
  id: string;
  /** The words from the post, as written. */
  quote: string;
  type: ClaimType;
  /** Upper-case ticker without the $, or null if the post never names one. */
  ticker: string | null;
  /** The company as the post names it ("Apple"), or null. Used when there is no ticker. */
  company: string | null;
  /** Growth claims: the percentage stated, as a positive number (300 for "up 300%"). */
  claimedPercent: number | null;
  direction: Direction | null;
  period: Period | null;
  /** Dollar-figure claims: which number. Null for other claim types. */
  metric: Metric | null;
  /**
   * Dollar-figure claims: the amount in US dollars, negative for a loss.
   * Earnings claims: earnings per share in dollars. Market-cap claims: the market value in dollars.
   */
  claimedAmount: number | null;
  /** The year the post names for the period ("2025 revenue", "Q2 2026"), if any. */
  fiscalYear: number | null;
  /** The quarter the post names ("Q2"), if any. */
  fiscalQuarter: Quarter | null;
  /** Set when the post states a floor or ceiling rather than a figure. */
  bound: Bound | null;
  /** Earnings claims: whether the post says the company beat or missed analyst estimates. */
  vsEstimate: EstimateResult | null;
  /** Price-move and market-value-change claims: the time span the move is said to cover. */
  window: PriceWindow | null;
  /**
   * Price-move and market-value-change claims: the span in days when it is not one of
   * the windows ("48 hours" is 2, "3 years" is 1095, "since IPO" or "all time" is 36500).
   */
  windowDays: number | null;
  /** Price-move claims: set for pre-market or after-hours moves. */
  session: Session | null;
  /** Price-move claims: the move is measured from a high, not over a time span. */
  reference: PriceReference | null;
  /** Growth claims: year over year or quarter over quarter, when the post says. */
  comparison: Comparison | null;
  /** The business line the claim is about ("Azure", "ad revenue", "data center"), or null for the whole company. */
  segment: string | null;
  /** Earnings-date claims: the day as the post says it ("today", "Thursday", "Nov 19"). Before or after the market is in session. */
  eventDate: string | null;
  /** The day the post was written (YYYY-MM-DD, New York time), when known. "Today" and "this week" mean that day's. */
  postedAt: string | null;
}

/** What the LLM (or the rule-based fallback) returns: a claim without an id. */
export type ExtractedClaim = Omit<Claim, 'id'>;

/** One row on the receipt screen. */
export interface EvidenceFigure {
  label: string;
  value: string;
}

export interface Citation {
  label: string;
  url: string;
}

export type GrowthBasisId = 'quarter_yoy' | 'quarter_qoq' | 'year_yoy';

export interface PeriodValue {
  start: string;
  end: string;
  value: number;
}

/** One way of measuring growth, e.g. latest quarter vs the same quarter last year. */
export interface GrowthBasis {
  id: GrowthBasisId;
  label: string;
  current: PeriodValue;
  prior: PeriodValue;
  percent: number;
}

/** One reported quarter or fiscal year of a metric. */
export interface ReportedPeriod extends PeriodValue {
  kind: Period;
  /** The company's own fiscal labels, when the data carries them. */
  fiscalYear: number | null;
  fiscalQuarter: Quarter | null;
  /** True for a fourth quarter worked out as full year minus the first three quarters. */
  derived: boolean;
  /** url: a direct link to the document when it is not the filing's folder (an earnings release). */
  filing: { accession: string; form: string; filed: string; url?: string };
  /** When the period was first reported (later filings repeat it as a comparison). */
  firstFiled?: string;
}

interface EvidenceBase {
  sourceId: string;
  ticker: string;
  entityName: string;
  /** End date of the most recent period in the data. */
  asOf: string;
  figures: EvidenceFigure[];
  citation: Citation;
}

export interface RevenueEvidence extends EvidenceBase {
  kind: 'revenue_growth';
  /** Growth for the latest periods on file. */
  bases: GrowthBasis[];
  /** Every quarter and year on file, newest first, so a claim about an earlier period can be checked. */
  quarters: ReportedPeriod[];
  years: ReportedPeriod[];
}

export interface FigureEvidence extends EvidenceBase {
  kind: 'financial_figure';
  metric: FigureMetric;
  cik: number;
  /** Newest first. */
  quarters: ReportedPeriod[];
  years: ReportedPeriod[];
}

/** One reported quarter of earnings per share, with the analyst estimate before it. */
export interface EarningsQuarter {
  /** End date of the quarter. */
  period: string;
  fiscalYear: number | null;
  fiscalQuarter: Quarter | null;
  actual: number | null;
  estimate: number | null;
  /** (actual - estimate) / |estimate| x 100. */
  surprisePercent: number | null;
}

export interface EarningsEvidence extends EvidenceBase {
  kind: 'earnings_result';
  /** Newest first. */
  quarters: EarningsQuarter[];
}

export interface MarketEvidence extends EvidenceBase {
  kind: 'market';
  /** When the price was read (ISO timestamp). Prices move, so every verdict says this. */
  readAt: string;
  price: number | null;
  /** Price change in percent over each window that the data covers. */
  returns: Partial<Record<PriceWindow, number>>;
  /** Market value in US dollars. */
  marketCap: number | null;
  /** The highest price of the past 52 weeks, and the day it was reached. */
  high52Week?: { price: number; date: string | null } | null;
}

/** A day's close, from price history. */
export interface PricePoint {
  date: string;
  price: number;
}

/**
 * A price measured on the post's own day from daily (and intraday) history,
 * not the price at the time of the check.
 */
export interface PriceHistoryEvidence extends EvidenceBase {
  kind: 'price_history';
  /** The trading day the post is about: the last session on or before its date. */
  sessionDate: string;
  /** True when the post could have been written during that session, so any price in the day's range counts. */
  intraday: boolean;
  /** False when that session is today's, so the numbers can still change. */
  settled: boolean;
  /** The first day on record. */
  firstDate: string;
  /** The close and the day's range on the session. */
  session: { open: number; high: number; low: number; close: number };
  /** The move over the claim's span, from the close before it to the session. */
  move?: { label: string; from: PricePoint; to: PricePoint; percent: number; lowPercent: number; highPercent: number };
  /** The highest price on record before the session. scope "52_week", or "history" (since firstDate). */
  high?: { price: number; date: string; scope: '52_week' | 'history'; complete: boolean };
  /** For "its high" with no span: the 52-week high too, since the post may mean either. */
  high52?: { price: number; date: string; scope: '52_week'; complete: true };
  /** A pre-market or after-hours move. */
  extended?: { kind: Session; base: PricePoint; last: PricePoint; percent: number; lowPercent: number; highPercent: number };
  /** Market value on the session, estimated from today's value and the price change since. */
  marketCap?: number;
  /** Why the claim's span or reference can't be measured from the history. */
  unavailable?: string;
}

/** One scheduled or past earnings report, with the analyst consensus before it. */
export interface CalendarReport {
  /** The day the company reports, YYYY-MM-DD. */
  date: string;
  /** Before the open, after the close, during market hours, or not known. */
  hour: 'bmo' | 'amc' | 'dmh' | null;
  fiscalYear: number | null;
  fiscalQuarter: Quarter | null;
  epsEstimate: number | null;
  revenueEstimate: number | null;
  epsActual: number | null;
  revenueActual: number | null;
}

export interface CalendarEvidence extends EvidenceBase {
  kind: 'earnings_calendar';
  /** Oldest first. */
  reports: CalendarReport[];
}

// Add new evidence kinds to this union as adapters are added
// (short interest, insider trades, ...).
export type Evidence = RevenueEvidence | FigureEvidence | EarningsEvidence | MarketEvidence | PriceHistoryEvidence | CalendarEvidence;

export interface CheckedClaim {
  claim: Claim;
  verdict: Verdict;
  /** One or two plain sentences. Built by code from the evidence, never by the LLM. */
  reason: string;
  evidence: Evidence | null;
}

export interface CheckResult {
  /** The first stock the post names. */
  ticker: string | null;
  /** Every stock the post's claims are about, in order. Posts often name several. */
  tickers: string[];
  entityName: string | null;
  claims: CheckedClaim[];
  summary: {
    total: number;
    /** Claims that got a real verdict (everything except cant_check). */
    checkable: number;
    holdsUp: number;
  };
  /** Which extractor read the post, e.g. "anthropic:claude-haiku-4-5" or "rule-based". */
  extractor: string;
  /** The day the post was written (YYYY-MM-DD, New York), when known. Missing on results saved before it existed. */
  postedAt?: string | null;
  checkedAt: string;
}
