import { useRef, useState, type DragEvent } from 'react';
import type { Mode } from '../api';
import { Disclaimer, Logo, TopBar } from './ui';

// The live examples use Apple's filings as of October 2026. The demo example
// uses the made-up company served in demo mode.
const EXAMPLES: Record<Mode, { label: string; text: string }[]> = {
  live: [
    {
      label: 'AAPL revenue up 30%',
      text:
        '$AAPL is unstoppable. Revenue hit $109B last quarter, up 30% from a year ago, and they did $416B ' +
        'in fiscal 2025. This goes to $400 by Christmas, I am loading up.',
    },
    { label: 'AAPL revenue up 300%', text: '$AAPL revenue is up 300% this quarter. Shorts are finished.' },
  ],
  demo: [
    {
      label: 'TGSR crushed earnings',
      text:
        '$TGSR just crushed earnings and nobody is talking about it. Revenue is up 300% this quarter. ' +
        'Short interest is over 40% of the float, so every short has to cover. This is a $40 stock by Friday.',
    },
  ],
};

interface HomeProps {
  text: string;
  onTextChange: (text: string) => void;
  /** A screenshot the person picked or pasted. */
  onScreenshot: (file: Blob) => void;
  /** True while a screenshot is being read. */
  reading: boolean;
  /** True when the text in the box came from a screenshot. */
  fromScreenshot: boolean;
  onSubmit: () => void;
  /** Signed-in email, or null for a guest. */
  email: string | null;
  onOpenAccount: () => void;
  loading: boolean;
  error: string | null;
  mode: Mode | null;
}

const PILLARS = [
  { label: 'Reads SEC filings', icon: <path d="M5 2.5h7l3.5 3.5v11.5H5z" /> },
  { label: 'Every verdict cited', icon: <path d="M10 2.5l6 2.2v4.6c0 3.6-2.5 6.3-6 7.4-3.5-1.1-6-3.8-6-7.4V4.7z" /> },
  { label: 'No buy or sell calls', icon: <path d="M4 16V11M10 16V5M16 16V8" /> },
];

export function Home({ text, onTextChange, onScreenshot, reading, fromScreenshot, onSubmit, email, onOpenAccount, loading, error, mode }: HomeProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = loading || reading;
  // Dragging over the form. A counter, because dragenter/dragleave fire for every child element.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  // Only file drags are taken over; dragging selected text into the box still works as usual.
  const hasFiles = (event: DragEvent) => [...event.dataTransfer.types].includes('Files');
  const drop = {
    onDragEnter: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
    },
    onDragLeave: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (busy) return;
      const image = [...event.dataTransfer.files].find((f) => f.type.startsWith('image/'));
      if (image) onScreenshot(image);
    },
  };

  return (
    <>
      <TopBar
        left={
          <span className="flex items-center gap-2 pl-3">
            <Logo />
            <span className="text-[19px] font-extrabold tracking-tight text-navy">Verifi</span>
          </span>
        }
        right={
          email ? (
            <button
              type="button"
              onClick={onOpenAccount}
              aria-label={`Account: ${email}`}
              className="mr-2 flex h-11 w-11 cursor-pointer items-center justify-center"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-navy text-[15px] font-bold text-white">
                {email[0]?.toUpperCase()}
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onOpenAccount}
              className="mr-2 h-9 cursor-pointer rounded-full bg-navy px-3.5 text-sm font-semibold text-white"
            >
              Sign in
            </button>
          )
        }
      />

      <div className="flex flex-1 flex-col gap-[18px] px-5 pt-[22px] pb-4">
        <span className="flex items-center gap-1.5 self-start rounded-xl bg-teal-soft px-2.5 py-1 text-xs font-bold tracking-wider text-teal-deep">
          EVIDENCE OVER HYPE
        </span>

        <h1 className="text-[31px] leading-[1.12] font-extrabold tracking-[-0.03em] text-navy">
          Check financial claims <span className="text-teal-dark">before you invest.</span>
        </h1>

        <p className="text-[15px] leading-normal text-body">
          Paste a post or upload a screenshot from social media (X, Reddit, etc.).
          <br/>
          We'll check each claim against SEC filings and market data.
        </p>

        <form
          {...drop}
          className={`flex flex-col gap-3 rounded-2xl border bg-white p-3.5 shadow-sm ${dragging ? 'border-teal-dark ring-2 ring-teal-soft' : 'border-line'}`}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="post" className="text-[13px] font-semibold text-body">
              Paste a post or claim
            </label>
            {text && (
              <button
                type="button"
                onClick={() => {
                  onTextChange('');
                  document.getElementById('post')?.focus();
                }}
                className="-my-2 flex min-h-11 cursor-pointer items-center gap-1 rounded-lg px-2 text-[13px] font-semibold text-teal-dark"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                Clear
              </button>
            )}
          </div>
          <textarea
            id="post"
            rows={5}
            value={text}
            disabled={reading}
            onChange={(event) => onTextChange(event.target.value)}
            onPaste={(event) => {
              // A screenshot pasted into the box (desktop, or iPhone "Copy" on an image).
              const image = [...event.clipboardData.files].find((f) => f.type.startsWith('image/'));
              if (image) {
                event.preventDefault();
                onScreenshot(image);
              }
            }}
            placeholder={
              dragging ? 'Drop the screenshot here' : reading ? 'Reading your screenshot…' : '$AAPL revenue hit $109B last quarter, up 30% from a year ago...'
            }
            className={`w-full resize-none rounded-xl border p-3 text-base leading-snug text-ink placeholder:text-muted disabled:opacity-60 ${
              dragging ? 'border-teal-dark bg-teal-soft/40' : 'border-dash bg-ground'
            }`}
          />
          {fromScreenshot && text && !reading && (
            <p className="rounded-lg bg-teal-soft px-3 py-2 text-[13px] leading-snug font-medium text-teal-deep">
              Read from your screenshot. Fix anything it got wrong, then check. The screenshot isn't saved.
            </p>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Reset so picking the same screenshot again still fires.
              event.target.value = '';
              if (file) onScreenshot(file);
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
            className="flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dash bg-white text-[15px] font-semibold text-navy disabled:cursor-not-allowed disabled:opacity-60"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
              <circle cx="7" cy="8" r="1.5" />
              <path d="M17.5 13l-4-4-7.5 7.5" />
            </svg>
            {reading ? 'Reading screenshot…' : 'Upload a screenshot (or drag one in)'}
          </button>
          {error && (
            <p role="alert" className="rounded-lg bg-contra-soft px-3 py-2 text-sm font-medium text-contra">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || !text.trim()}
            className="flex h-[50px] cursor-pointer items-center justify-center gap-2 rounded-xl bg-navy text-base font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? 'Checking the filings…' : 'Check claims'}
          </button>
        </form>

        <div className="flex flex-col gap-2.5">
          <span className="text-[13px] font-semibold text-body">Try an example</span>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES[mode ?? 'live'].map((ex) => (
              <button
                key={ex.label}
                type="button"
                onClick={() => onTextChange(ex.text)}
                className="min-h-9 cursor-pointer rounded-full bg-mint px-3 text-[13px] font-semibold text-teal-deep"
              >
                "{ex.label}"
              </button>
            ))}
          </div>
        </div>

        <div className="mt-auto flex gap-2.5 pt-2">
          {PILLARS.map((p) => (
            <div key={p.label} className="flex flex-1 flex-col gap-1.5 rounded-xl border border-line bg-white p-3">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="text-navy" aria-hidden="true">
                {p.icon}
              </svg>
              <span className="text-xs leading-snug font-semibold text-strong">{p.label}</span>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-1">
          <Disclaimer />
          {mode === 'demo' && <p className="text-[11px] text-muted">Demo mode: checks a made-up company, not live filings.</p>}
        </div>
      </div>
    </>
  );
}
