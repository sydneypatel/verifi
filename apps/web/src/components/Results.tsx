import type { CheckResult } from '@hypecheck/check-core';
import { BackButton, Disclaimer, VERDICTS, VerdictBadge } from './ui';

interface ResultsProps {
  result: CheckResult;
  onBack: () => void;
  onOpenClaim: (index: number) => void;
}

function headline({ summary }: CheckResult): { lead: string; rest: string } {
  if (summary.total === 0) return { lead: 'No claims', rest: 'found in this post.' };
  if (summary.checkable === 0) return { lead: 'Nothing here', rest: 'can be checked yet.' };
  if (summary.checkable === 1) {
    return { lead: 'The 1 checkable claim', rest: summary.holdsUp === 1 ? 'holds up.' : "doesn't hold up." };
  }
  return {
    lead: `${summary.holdsUp} of ${summary.checkable}`,
    rest: `checkable claims ${summary.holdsUp === 1 ? 'holds' : 'hold'} up.`,
  };
}

export function Results({ result, onBack, onOpenClaim }: ResultsProps) {
  const { lead, rest } = headline(result);

  return (
    <div className="flex flex-1 flex-col gap-3">
      <header className="flex items-center justify-between">
        <BackButton onClick={onBack} label="Check another post" />
        <span className="font-mono text-sm font-semibold tracking-wider uppercase">
          {[result.ticker, result.entityName].filter(Boolean).join(' · ') || 'Results'}
        </span>
        <span className="w-8" />
      </header>

      <section className="flex flex-col gap-3 rounded-[14px] bg-ink p-4 text-white">
        <h1 className="text-[23px] leading-tight font-bold tracking-tight">
          <span className="text-accent">{lead}</span> {rest}
        </h1>
        {result.claims.length > 0 && (
          <div className="flex h-2 gap-1" aria-hidden="true">
            {result.claims.map((c) => (
              <span key={c.claim.id} className={`flex-1 rounded ${VERDICTS[c.verdict].bar}`} />
            ))}
          </div>
        )}
      </section>

      {result.claims.length === 0 && (
        <p className="rounded-xl border border-dashed border-dash p-4 text-sm leading-relaxed text-body">
          HypeCheck looks for specific, factual statements, like "revenue is up 40%". This post doesn't seem to make any.
        </p>
      )}

      <ul className="flex flex-col gap-2.5">
        {result.claims.map((c, index) => (
          <li key={c.claim.id}>
            <button
              type="button"
              onClick={() => onOpenClaim(index)}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-line bg-white py-3 pr-2.5 pl-3.5 text-left"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <VerdictBadge verdict={c.verdict} />
                <span className="text-base leading-snug font-semibold">"{c.claim.quote}"</span>
                <span className="text-sm leading-snug text-body">{c.reason}</span>
              </span>
              <svg width="20" height="20" viewBox="0 0 22 22" fill="none" className="shrink-0 text-muted" aria-hidden="true">
                <path d="M8.5 5l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-auto flex flex-col gap-1 pt-4">
        <Disclaimer />
        <p className="font-mono text-[11px] text-muted">Read by {result.extractor}</p>
      </div>
    </div>
  );
}
