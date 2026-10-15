import type { CheckResult } from '@hypecheck/check-core';
import { allHype, segmentPost, summarizePost, tickersOf, titleOf } from '../post';
import { BackButton, Chevron, ClaimNumber, Disclaimer, TopBar, VERDICTS, VerdictBadge } from './ui';

interface ResultsProps {
  text: string;
  result: CheckResult;
  onBack: () => void;
  onOpenClaim: (index: number) => void;
}

function headline(result: CheckResult): { lead: string; rest: string } {
  const { summary } = result;
  if (allHype(result)) return { lead: 'All hype:', rest: 'predictions only, no facts to check.' };
  if (summary.total === 0) return { lead: 'No claims', rest: 'found in this post.' };
  if (summary.checkable === 0) return { lead: 'Nothing here', rest: 'can be checked yet.' };
  if (summary.checkable === 1) {
    return { lead: 'The 1 checkable claim', rest: summary.holdsUp === 1 ? 'holds up.' : "doesn't hold up." };
  }
  return { lead: `${summary.holdsUp} of ${summary.checkable}`, rest: `checkable claims ${summary.holdsUp === 1 ? 'holds' : 'hold'} up.` };
}

export function Results({ text, result, onBack, onOpenClaim }: ResultsProps) {
  const { lead, rest } = headline(result);
  const segments = segmentPost(text, result.claims);
  const summary = summarizePost(result);
  const { title, subtitle } = titleOf(result);
  const multi = tickersOf(result).length > 1;

  return (
    <>
      <TopBar
        left={<BackButton onClick={onBack} label="Back" />}
        center={
          <>
            <span className="max-w-[260px] truncate text-[15px] font-bold text-navy">{title}</span>
            <span className="max-w-[260px] truncate text-xs text-muted">{subtitle ?? `${result.claims.length} claims found`}</span>
          </>
        }
      />

      <div className="flex flex-1 flex-col gap-3 px-4 pt-4 pb-4">
        <section aria-labelledby="post-heading" className="flex flex-col gap-2 rounded-2xl border border-line bg-white p-4">
          <h2 id="post-heading" className="text-xs font-bold tracking-wider text-muted">
            THE POST
          </h2>
          <p className="text-[15px] leading-[1.75] whitespace-pre-line text-ink">
            {segments.map((s, i) => {
              if (s.claimIndex === null) return <span key={i}>{s.text}</span>;
              const claim = result.claims[s.claimIndex]!;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => onOpenClaim(s.claimIndex!)}
                  aria-label={`Claim ${s.claimIndex + 1}, ${VERDICTS[claim.verdict].label}: ${s.text}`}
                  className={`inline cursor-pointer rounded px-0.5 text-left underline decoration-2 underline-offset-4 ${VERDICTS[claim.verdict].mark}`}
                >
                  {s.text}
                  <ClaimNumber n={s.claimIndex + 1} />
                </button>
              );
            })}
          </p>
        </section>

        <section className="flex flex-col gap-2.5 rounded-2xl bg-navy p-4 text-white">
          <h2 className="text-xl leading-tight font-bold tracking-tight">
            <span className="text-teal-on-navy">{lead}</span> {rest}
          </h2>
          {result.claims.length > 0 && (
            <div className="flex h-1.5 gap-1" aria-hidden="true">
              {result.claims.map((c) => (
                <span key={c.claim.id} className={`flex-1 rounded ${VERDICTS[c.verdict].onNavy}`} />
              ))}
            </div>
          )}
        </section>

        <ol className="flex flex-col gap-2">
          {result.claims.map((c, index) => (
            <li key={c.claim.id}>
              <button
                type="button"
                onClick={() => onOpenClaim(index)}
                className="flex w-full cursor-pointer items-center gap-2.5 rounded-2xl border border-line bg-white py-3 pr-2.5 pl-3.5 text-left"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="flex items-center gap-2">
                    <span className="flex h-5 min-w-5 items-center justify-center rounded bg-navy px-1 text-[11px] font-bold text-white">{index + 1}</span>
                    <VerdictBadge verdict={c.verdict} />
                    {multi && c.claim.ticker && (
                      <span className="ml-auto rounded bg-line px-1.5 py-0.5 text-[11px] font-extrabold tracking-wide text-navy">{c.claim.ticker}</span>
                    )}
                  </span>
                  <span className="text-[15px] leading-snug font-semibold">"{c.claim.quote}"</span>
                  <span className="text-[13px] leading-snug text-body">{c.reason}</span>
                </span>
                <Chevron />
              </button>
            </li>
          ))}
        </ol>

        <section aria-labelledby="summary-heading" className="flex flex-col gap-2 rounded-2xl border border-teal/40 bg-mint p-4">
          <h2 id="summary-heading" className="flex items-center gap-2 text-[15px] font-bold text-teal-deep">
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M5 2.5h7l3.5 3.5v11.5H5z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
              <path d="M7.5 10h5M7.5 13h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
            Summary
          </h2>
          {summary.map((line) => (
            <p key={line} className="text-sm leading-relaxed text-strong">
              {line}
            </p>
          ))}
        </section>

        <div className="flex flex-col gap-1 pt-1">
          <Disclaimer>Saved to History on this device. HypeCheck checks claims; it does not tell you to buy or sell. Not financial advice.</Disclaimer>
          <p className="text-[11px] text-muted">Read by {result.extractor}</p>
        </div>
      </div>
    </>
  );
}
