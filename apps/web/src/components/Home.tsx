import { Disclaimer, Logo } from './ui';

import type { Mode } from '../api';

// The live example uses Apple's filings as of October 2026. The demo example
// uses the made-up company served in demo mode.
const EXAMPLES: Record<Mode, string> = {
  live:
    '$AAPL is unstoppable. Revenue hit $109B last quarter, up 30% from a year ago, and they did $416B ' +
    'in fiscal 2025. This goes to $400 by Christmas, I am loading up.',
  demo:
    '$TGSR just crushed earnings and nobody is talking about it. Revenue is up 300% this quarter. ' +
    'Short interest is over 40% of the float, so every short has to cover. This is a $40 stock by Friday.',
};

interface HomeProps {
  text: string;
  onTextChange: (text: string) => void;
  onSubmit: () => void;
  loading: boolean;
  error: string | null;
  mode: Mode | null;
}

export function Home({ text, onTextChange, onSubmit, loading, error, mode }: HomeProps) {
  return (
    <div className="flex flex-1 flex-col gap-5">
      <header className="flex items-center gap-2.5">
        <Logo />
        <span className="text-[19px] font-extrabold tracking-tight">HypeCheck</span>
      </header>

      <h1 className="text-[34px] leading-[1.08] font-extrabold tracking-[-0.03em]">Check the post before you buy.</h1>

      <form
        className="flex flex-col gap-3 rounded-2xl border-2 border-ink bg-white p-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label htmlFor="post" className="text-sm font-bold">
          Paste a post
        </label>
        <textarea
          id="post"
          rows={6}
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          placeholder="$TICKER just crushed earnings, revenue is up 300%..."
          className="w-full resize-none rounded-[10px] border border-dash bg-ground p-3 text-base leading-snug text-ink placeholder:text-muted"
        />
        {error && (
          <p role="alert" className="rounded-lg bg-mislead-soft px-3 py-2 text-sm font-medium text-mislead">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={loading || !text.trim()}
          className="flex h-[52px] cursor-pointer items-center justify-center gap-2 rounded-xl bg-ink text-base font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? 'Checking the filings…' : 'Check claims'}
        </button>
      </form>

      <button
        type="button"
        onClick={() => onTextChange(EXAMPLES[mode ?? 'live'])}
        className="min-h-11 cursor-pointer self-start rounded-xl border border-dashed border-dash px-3.5 text-sm font-semibold text-ink"
      >
        Try an example post
      </button>

      <div className="mt-auto flex flex-col gap-1 pt-4">
        <Disclaimer />
        {mode === 'demo' && <p className="font-mono text-[11px] text-muted">Demo mode: checks a made-up company, not live filings.</p>}
      </div>
    </div>
  );
}
