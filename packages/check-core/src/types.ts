// Shared types for the whole product. The web app, the extension and any
// later native client all render a CheckResult and nothing else.

export type ClaimType =
  | 'revenue_growth'
  | 'financial_figure'
  | 'short_interest'
  | 'corporate_event'
  | 'prediction'
  | 'opinion'
  | 'other';

export type Verdict = 'holds_up' | 'misleading' | 'contradicted' | 'cant_check';

export type Direction = 'up' | 'down';
export type Period = 'quarter' | 'year';
export type Quarter = 1 | 2 | 3 | 4;

/** Which reported number a dollar-figure claim is about. */
export type Metric = 'revenue' | 'net_income' | 'other';

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
  /** Dollar-figure claims: the amount in US dollars. Negative for a loss. */
  claimedAmount: number | null;
  /** The year the post names for the period ("2025 revenue", "Q2 2026"), if any. */
  fiscalYear: number | null;
  /** The quarter the post names ("Q2"), if any. */
  fiscalQuarter: Quarter | null;
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
  filing: { accession: string; form: string; filed: string };
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
  bases: GrowthBasis[];
}

export interface FigureEvidence extends EvidenceBase {
  kind: 'financial_figure';
  metric: Exclude<Metric, 'other'>;
  cik: number;
  /** Newest first. */
  quarters: ReportedPeriod[];
  years: ReportedPeriod[];
}

// Add new evidence kinds to this union as adapters are added
// (short interest, 8-K events, insider trades, ...).
export type Evidence = RevenueEvidence | FigureEvidence;

export interface CheckedClaim {
  claim: Claim;
  verdict: Verdict;
  /** One or two plain sentences. Built by code from the evidence, never by the LLM. */
  reason: string;
  evidence: Evidence | null;
}

export interface CheckResult {
  ticker: string | null;
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
  checkedAt: string;
}
