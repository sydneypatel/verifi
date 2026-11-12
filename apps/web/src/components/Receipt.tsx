import type { CheckResult, Evidence } from '@verifi/check-core';
import { BackButton, Disclaimer, TopBar, VERDICTS, VerdictBadge } from './ui';

interface ReceiptProps {
  result: CheckResult;
  index: number;
  onBack: () => void;
  onNext: () => void;
}

/** How each kind of evidence is labelled on the receipt. */
function describeSource(evidence: Evidence): { badge: string; heading: string; link: string; limits: string } {
  const filingLimits = 'Whether the stock is fairly priced, or where it goes next.';
  switch (evidence.kind) {
    case 'market':
      return {
        badge: 'MKT',
        heading: 'MARKET DATA',
        link: 'View quote',
        limits: 'Prices move all day. This compares the post with the price when you checked, not when the post was written.',
      };
    case 'earnings_result':
      return {
        badge: 'EPS',
        heading: 'EARNINGS PER SHARE VS ESTIMATES',
        link: 'View history',
        limits: 'Adjusted EPS, as analysts track it. The GAAP figure in the filing can differ.',
      };
    default: {
      const form = evidence.citation.label.match(/Form ([^,\s]+)/)?.[1] ?? 'SEC';
      const metric = evidence.kind === 'financial_figure' && evidence.metric === 'net_income' ? 'NET INCOME' : 'REVENUE';
      const release = form === '8-K';
      return {
        badge: form,
        heading: release ? `${metric}, FROM THE EARNINGS RELEASE` : `${metric}, AS FILED`,
        link: 'View on SEC',
        limits: release ? `${filingLimits} The 10-Q with full detail comes later.` : filingLimits,
      };
    }
  }
}

const PANEL: Record<string, string> = {
  holds_up: 'border-holds-bar/30 bg-holds-soft/50',
  misleading: 'border-mislead-bar/30 bg-mislead-soft/60',
  contradicted: 'border-contra-bar/30 bg-contra-soft/50',
  cant_check: 'border-line bg-surface',
};

export function Receipt({ result, index, onBack, onNext }: ReceiptProps) {
  const checked = result.claims[index];
  if (!checked) return null;
  const { claim, verdict, reason, evidence } = checked;
  const isLast = index === result.claims.length - 1;
  const source = evidence ? describeSource(evidence) : null;

  return (
    <>
      <TopBar
        left={<BackButton onClick={onBack} label="Back to results" />}
        center={
          <span className="text-[15px] font-bold text-navy">
            Claim {index + 1} of {result.claims.length}
          </span>
        }
      />

      <div className="flex flex-1 flex-col gap-3.5 px-4 pt-[18px] pb-4">
        <section className={`flex flex-col gap-2.5 rounded-2xl border p-4 ${PANEL[verdict]}`}>
          <VerdictBadge verdict={verdict} size="lg" />
          <h2 className="text-[13px] font-semibold text-muted">The post says</h2>
          <p className="text-[21px] leading-tight font-bold text-ink">"{claim.quote}"</p>
          <p className="text-sm leading-normal text-strong">{reason}</p>
        </section>

        {evidence && (
          <section className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-3.5">
            <div className="flex items-center gap-2.5">
              <span className="flex h-10 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-[10px] font-extrabold text-white">
                {source!.badge}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[15px] font-bold text-ink">{evidence.entityName}</span>
                <span className="text-xs text-muted">{evidence.citation.label}</span>
              </span>
              <a
                href={evidence.citation.url}
                target="_blank"
                rel="noreferrer"
                className="flex min-h-9 shrink-0 items-center rounded-lg border border-dash px-2.5 text-xs font-semibold text-navy no-underline"
              >
                {source!.link}
              </a>
            </div>
            <h3 className="text-xs font-bold tracking-wider text-muted">{source!.heading}</h3>
            <dl className="flex flex-col gap-2 rounded-xl bg-ground p-3 text-sm">
              {evidence.figures.map((row) => {
                const isChange = row.label.startsWith('Change');
                return (
                  <div key={row.label} className={`flex justify-between gap-3 ${isChange ? 'border-b border-dashed border-dash pb-2 last:border-0 last:pb-0' : ''}`}>
                    <dt className={isChange ? 'font-semibold text-ink' : 'text-body'}>{row.label}</dt>
                    <dd className={`font-bold ${isChange ? 'text-teal-dark' : 'text-ink'}`}>{row.value}</dd>
                  </div>
                );
              })}
            </dl>
          </section>
        )}

        <section className="flex flex-col gap-1 rounded-xl border border-dashed border-dash px-3.5 py-3">
          <h2 className="text-[13px] font-bold text-navy">What this check does not cover</h2>
          <p className="text-[13px] leading-normal text-body">{source?.limits ?? 'Whether the stock is fairly priced, or where it goes next.'}</p>
        </section>

        <div className="mt-auto flex flex-col gap-2 pt-2">
          <button
            type="button"
            onClick={isLast ? onBack : onNext}
            className="flex h-12 cursor-pointer items-center justify-center rounded-xl bg-primary text-[15px] font-bold text-white"
          >
            {isLast ? 'Back to the post' : `Next claim (${VERDICTS[result.claims[index + 1]!.verdict].label})`}
          </button>
          <Disclaimer>Not financial advice.</Disclaimer>
        </div>
      </div>
    </>
  );
}
