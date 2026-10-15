import type { CheckResult } from '@hypecheck/check-core';
import { BackButton, Disclaimer, VerdictBadge } from './ui';

interface ReceiptProps {
  result: CheckResult;
  index: number;
  onBack: () => void;
  onNext: () => void;
}

export function Receipt({ result, index, onBack, onNext }: ReceiptProps) {
  const checked = result.claims[index];
  if (!checked) return null;
  const { claim, verdict, reason, evidence } = checked;
  const isLast = index === result.claims.length - 1;

  return (
    <div className="flex flex-1 flex-col gap-4">
      <header className="flex items-center justify-between">
        <BackButton onClick={onBack} label="Back to results" />
        <span className="font-mono text-sm font-semibold tracking-wider">
          CLAIM {index + 1} OF {result.claims.length}
        </span>
        <span className="w-8" />
      </header>

      <section className="flex flex-col gap-2.5">
        <VerdictBadge verdict={verdict} large />
        <h2 className="text-[13px] font-bold text-muted">The post says</h2>
        <p className="text-[26px] leading-tight font-extrabold tracking-tight">"{claim.quote}"</p>
      </section>

      {evidence && (
        <section className="flex flex-col gap-2 rounded border border-line bg-white px-4 py-[18px] font-mono text-sm">
          <h2 className="text-xs font-semibold tracking-wider text-muted">
            {evidence.kind === 'financial_figure' && evidence.metric === 'net_income' ? 'NET INCOME, AS FILED' : 'REVENUE, AS FILED'}
          </h2>
          <dl className="flex flex-col gap-2">
            {evidence.figures.map((row) => (
              <div
                key={row.label}
                className={`flex justify-between gap-3 ${row.label.startsWith('Change') ? 'border-b border-dashed border-dash pb-2 font-semibold last:border-0 last:pb-0' : ''}`}
              >
                <dt>{row.label}</dt>
                <dd className="font-semibold">{row.value}</dd>
              </div>
            ))}
          </dl>
          <a href={evidence.citation.url} target="_blank" rel="noreferrer" className="mt-1.5 font-sans text-[13px] font-semibold text-holds underline">
            {evidence.citation.label}
          </a>
        </section>
      )}

      <section className="flex flex-col gap-1.5">
        <h2 className="text-[15px] font-bold">{evidence ? 'What we found' : "Why it can't be checked"}</h2>
        <p className="text-[15px] leading-normal text-body">{reason}</p>
      </section>

      <section className="flex flex-col gap-1.5 rounded-xl border border-dashed border-dash p-3.5">
        <h2 className="text-[13px] font-bold">What this check does not cover</h2>
        <p className="text-[13px] leading-normal text-body">
          Whether the stock is fairly priced, or where it goes next. HypeCheck verifies claims, not valuations.
        </p>
      </section>

      <div className="mt-auto flex flex-col gap-2.5 pt-4">
        <button
          type="button"
          onClick={isLast ? onBack : onNext}
          className="flex h-[52px] cursor-pointer items-center justify-center rounded-xl bg-ink text-base font-bold text-white"
        >
          {isLast ? 'Back to all claims' : 'Next claim'}
        </button>
        <Disclaimer>Not financial advice.</Disclaimer>
      </div>
    </div>
  );
}
