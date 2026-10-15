import type { Verdict } from '@hypecheck/check-core';
import type { ReactNode } from 'react';

export const VERDICTS: Record<Verdict, { label: string; badge: string; bar: string; icon: string }> = {
  holds_up: { label: 'Holds up', badge: 'bg-holds-soft text-holds', bar: 'bg-holds-bar', icon: 'M3 8.5l3.2 3.2L13 5' },
  misleading: {
    label: 'Misleading',
    badge: 'bg-mislead-soft text-mislead',
    bar: 'bg-mislead-bar',
    icon: 'M2.5 9c1.5-3 3.5-3 5.5-1s4 2 5.5-1',
  },
  contradicted: { label: 'Contradicted', badge: 'bg-contra text-white', bar: 'bg-contra-bar', icon: 'M4 4l8 8M12 4l-8 8' },
  cant_check: { label: "Can't be checked", badge: 'bg-unknown-soft text-unknown', bar: 'bg-unknown-bar', icon: 'M4 8h8' },
};

export function VerdictBadge({ verdict, large = false }: { verdict: Verdict; large?: boolean }) {
  const v = VERDICTS[verdict];
  return (
    <span
      className={`inline-flex items-center gap-1.5 self-start rounded-full font-bold ${v.badge} ${
        large ? 'py-1 pl-2 pr-3 text-[15px]' : 'py-0.5 pl-1.5 pr-2.5 text-[13px]'
      }`}
    >
      <svg width={large ? 16 : 14} height={large ? 16 : 14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d={v.icon} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {v.label}
    </span>
  );
}

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <rect width="28" height="28" rx="7" className="fill-ink" />
      <path d="M7.5 14.5l4.2 4.2L20.5 9.5" className="stroke-accent" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="-ml-3 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-ink"
    >
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
        <path d="M13.5 5l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

export function Disclaimer({ children }: { children?: ReactNode }) {
  return (
    <p className="text-xs leading-relaxed text-muted">
      {children ?? 'HypeCheck checks claims. It does not tell you to buy or sell. Not financial advice.'}
    </p>
  );
}
