import type { CheckResult, CheckedClaim } from '@hypecheck/check-core';

export type Segment = { text: string; claimIndex: number | null };

/**
 * Split the post into plain text and highlighted claim spans. Each claim's
 * quote is found in the post (the extractor copies quotes word for word);
 * a quote that can't be found, or overlaps an earlier one, is just not
 * highlighted, and still appears in the claim list.
 */
export function segmentPost(text: string, claims: CheckedClaim[]): Segment[] {
  const lower = text.toLowerCase();
  const spans: { start: number; end: number; claimIndex: number }[] = [];

  claims.forEach((c, claimIndex) => {
    const quote = c.claim.quote.trim();
    if (!quote) return;
    let from = 0;
    while (from <= lower.length) {
      const start = lower.indexOf(quote.toLowerCase(), from);
      if (start === -1) return;
      const end = start + quote.length;
      if (!spans.some((s) => start < s.end && end > s.start)) {
        spans.push({ start, end, claimIndex });
        return;
      }
      from = start + 1;
    }
  });

  spans.sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let pos = 0;
  for (const s of spans) {
    if (s.start > pos) out.push({ text: text.slice(pos, s.start), claimIndex: null });
    out.push({ text: text.slice(s.start, s.end), claimIndex: s.claimIndex });
    pos = s.end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), claimIndex: null });
  return out;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Every stock a check is about. Older saved checks only have `ticker`. */
export function tickersOf(result: CheckResult): string[] {
  if (Array.isArray(result.tickers)) return result.tickers;
  return result.ticker ? [result.ticker] : [];
}

/** "AAPL · Apple Inc.", or "5 stocks" for a multi-stock post. */
export function titleOf(result: CheckResult): { title: string; subtitle: string | null } {
  const tickers = tickersOf(result);
  if (tickers.length > 1) {
    const shown = tickers.slice(0, 4).join(', ');
    return { title: `${tickers.length} stocks`, subtitle: tickers.length > 4 ? `${shown} +${tickers.length - 4}` : shown };
  }
  const t = tickers[0] ?? null;
  if (t) return { title: result.entityName ? `${t} · ${result.entityName}` : t, subtitle: null };
  return { title: result.entityName ?? 'Results', subtitle: null };
}

/** True when every claim is a prediction or opinion: hype with nothing to check. */
export function allHype(result: CheckResult): boolean {
  return result.claims.length > 0 && result.claims.every((c) => c.claim.type === 'prediction' || c.claim.type === 'opinion');
}

/** A plain-language wrap-up of the post, built from the verdicts. No LLM. */
export function summarizePost(result: CheckResult): string[] {
  const count = (v: CheckedClaim['verdict']) => result.claims.filter((c) => c.verdict === v).length;
  const holds = count('holds_up');
  const misleading = count('misleading');
  const contradicted = count('contradicted');
  const cant = count('cant_check');
  const tickers = tickersOf(result);
  const subject =
    tickers.length > 1
      ? `${tickers.length} stocks (${tickers.join(', ')})`
      : (result.entityName ?? result.ticker ?? 'this company').replace(/\.$/, '');

  if (result.claims.length === 0) {
    return ['This post makes no specific factual claims, so there is nothing to check against filings.'];
  }

  if (allHype(result)) {
    return [
      `This post makes ${plural(result.claims.length, 'claim', 'claims')} about ${subject}, and every one is a price target, buy call or prediction.`,
      'None of them is a fact that a filing can confirm, and the post gives no evidence for any of the targets.',
      'Treat it as an opinion, not as research.',
    ];
  }

  const lines: string[] = [];
  const parts = [
    holds && `${holds} ${holds === 1 ? 'holds' : 'hold'} up`,
    misleading && `${misleading} ${misleading === 1 ? 'is' : 'are'} misleading`,
    contradicted && `${contradicted} ${contradicted === 1 ? 'is' : 'are'} contradicted by the data`,
    cant && `${cant} can't be checked`,
  ].filter(Boolean) as string[];
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  lines.push(`This post makes ${plural(result.claims.length, 'claim', 'claims')} about ${subject}: ${list}.`);

  const worst = result.claims.find((c) => c.verdict === 'contradicted') ?? result.claims.find((c) => c.verdict === 'misleading');
  if (worst) {
    lines.push(`The biggest gap is "${worst.claim.quote}". ${worst.reason}`);
  } else if (holds > 0 && misleading + contradicted === 0) {
    lines.push('Every claim we could check matches the filings and market data.');
  }

  if (cant > 0) {
    const kinds = new Set(result.claims.filter((c) => c.verdict === 'cant_check').map((c) => c.claim.type));
    if (kinds.has('prediction') || kinds.has('opinion')) {
      lines.push('Predictions and opinions in the post are hype, not facts: no filing can confirm them.');
    }
  }
  return lines;
}
