import type { Verdict } from '@hypecheck/check-core';
import type { ReactNode } from 'react';

export const VERDICTS: Record<
  Verdict,
  { label: string; badge: string; bar: string; onNavy: string; mark: string; icon: string }
> = {
  holds_up: {
    label: 'Holds up',
    badge: 'bg-holds-soft text-holds',
    bar: 'bg-holds-bar',
    onNavy: 'bg-holds-on-navy',
    mark: 'bg-holds-soft decoration-holds-bar',
    icon: 'M3 8.5l3.2 3.2L13 5',
  },
  misleading: {
    label: 'Misleading',
    badge: 'bg-mislead-soft text-mislead',
    bar: 'bg-mislead-bar',
    onNavy: 'bg-mislead-on-navy',
    mark: 'bg-mislead-soft decoration-mislead-bar',
    icon: 'M2.5 9c1.5-3 3.5-3 5.5-1s4 2 5.5-1',
  },
  contradicted: {
    label: 'Contradicted',
    badge: 'bg-contra-soft text-contra',
    bar: 'bg-contra-bar',
    onNavy: 'bg-contra-on-navy',
    mark: 'bg-contra-soft decoration-contra-bar',
    icon: 'M4 4l8 8M12 4l-8 8',
  },
  cant_check: {
    label: "Can't be checked",
    badge: 'bg-unknown-soft text-unknown',
    bar: 'bg-unknown-bar',
    onNavy: 'bg-unknown-on-navy',
    mark: 'bg-unknown-soft decoration-unknown-bar',
    icon: 'M4 8h8',
  },
};

export function VerdictBadge({ verdict, size = 'md', inline = false }: { verdict: Verdict; size?: 'sm' | 'md' | 'lg'; inline?: boolean }) {
  const v = VERDICTS[verdict];
  const sizes = {
    sm: 'py-0.5 pl-1.5 pr-2 text-[11px]',
    md: 'py-0.5 pl-1.5 pr-2.5 text-xs',
    lg: 'py-1 pl-2 pr-3 text-sm',
  };
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 ${inline ? '' : 'self-start'} rounded-full font-bold ${v.badge} ${sizes[size]}`}>
      <svg width={size === 'lg' ? 15 : 13} height={size === 'lg' ? 15 : 13} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d={v.icon} stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {v.label}
    </span>
  );
}

/** Small numbered tag tying a highlight in the post to its claim card. */
export function ClaimNumber({ n }: { n: number }) {
  return (
    <span className="ml-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded bg-navy px-1 align-[2px] text-[11px] font-bold text-white no-underline">
      {n}
    </span>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" className="stroke-navy" strokeWidth="2.6" />
      <path d="M18.4 18.4L24 24" className="stroke-navy" strokeWidth="2.8" strokeLinecap="round" />
      <path d="M8.2 12.2l2.6 2.6 5-5.2" className="stroke-teal" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TopBar({ left, center, right }: { left?: ReactNode; center?: ReactNode; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center justify-between gap-2 border-b border-line bg-white px-2">
      <div className="flex min-w-11 items-center">{left}</div>
      <div className="flex min-w-0 flex-col items-center text-center">{center}</div>
      <div className="flex min-w-11 items-center justify-end">{right}</div>
    </header>
  );
}

export function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-navy"
    >
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
        <path d="M13.5 5l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

export function Chevron() {
  return (
    <svg width="18" height="18" viewBox="0 0 22 22" fill="none" className="shrink-0 text-unknown-bar" aria-hidden="true">
      <path d="M8.5 5l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Disclaimer({ children }: { children?: ReactNode }) {
  return (
    <p className="text-xs leading-relaxed text-muted">
      {children ?? 'HypeCheck checks claims. It does not tell you to buy or sell. Not financial advice.'}
    </p>
  );
}

export type Tab = 'check' | 'history' | 'tickers';

const TABS: { id: Tab; label: string; path: ReactNode }[] = [
  {
    id: 'check',
    label: 'Check',
    path: (
      <>
        <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2" />
        <path d="M15.2 15.2L19.5 19.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M7 10.2l2 2 4-4.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
  {
    id: 'history',
    label: 'History',
    path: (
      <>
        <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="1.9" />
        <path d="M11 6.5V11l3 2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
  {
    id: 'tickers',
    label: 'Tickers',
    path: <path d="M3 16l5-6 4 3 7-8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />,
  },
];

export function TabBar({ active, onSelect }: { active: Tab; onSelect: (tab: Tab) => void }) {
  return (
    <nav aria-label="Main" className="sticky bottom-0 z-10 flex h-[72px] shrink-0 border-t border-line bg-white px-3 pb-3">
      {TABS.map((tab) => {
        const on = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelect(tab.id)}
            aria-current={on ? 'page' : undefined}
            className={`relative flex flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 text-xs ${
              on ? 'font-bold text-navy' : 'font-semibold text-muted'
            }`}
          >
            {on && <span className="absolute top-0 h-[3px] w-8 rounded-b bg-teal" aria-hidden="true" />}
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
              {tab.path}
            </svg>
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
