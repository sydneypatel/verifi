import { useEffect, useState } from 'react';
import { sendCode, verifyCode } from '../account';
import { BackButton, TopBar } from './ui';

interface AccountProps {
  /** The signed-in email, or null for a guest. */
  email: string | null;
  onBack: () => void;
  onSignOut: () => void;
}

const RESEND_AFTER_S = 60;

export function Account({ email, onBack, onSignOut }: AccountProps) {
  return (
    <>
      <TopBar
        left={<BackButton onClick={onBack} label="Back" />}
        center={<span className="text-[17px] font-bold text-navy">{email ? 'Account' : 'Sign in'}</span>}
      />
      <div className="flex flex-1 flex-col gap-5 px-5 pt-6 pb-6">{email ? <SignedIn email={email} onSignOut={onSignOut} /> : <SignIn />}</div>
    </>
  );
}

function SignedIn({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <section className="flex items-center gap-3 rounded-2xl border border-line bg-white p-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-navy text-lg font-bold text-white" aria-hidden="true">
          {email[0]?.toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-xs font-semibold text-muted">Signed in as</span>
          <span className="truncate text-base font-bold text-ink">{email}</span>
        </span>
      </section>

      <section className="flex items-start gap-2.5 rounded-xl bg-mint px-3.5 py-3">
        <svg width="18" height="18" viewBox="0 0 22 22" fill="none" className="mt-px shrink-0 text-teal-deep" aria-hidden="true">
          <path d="M4 11.5l4.5 4.5L18 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <p className="text-[13px] leading-normal text-teal-deep">
          Your history and followed tickers are saved to your account and show up on every device you sign in on.
        </p>
      </section>

      <div className="mt-auto flex flex-col gap-2">
        {confirming ? (
          <>
            <p className="text-center text-[13px] leading-normal text-body">
              This removes your history and tickers from this device. They stay in your account.
            </p>
            <button type="button" onClick={onSignOut} className="h-12 cursor-pointer rounded-xl bg-navy text-base font-bold text-white">
              Sign out
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="h-11 cursor-pointer text-sm font-semibold text-body">
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="h-12 cursor-pointer rounded-xl border border-dash bg-white text-base font-semibold text-navy"
          >
            Sign out
          </button>
        )}
      </div>
    </>
  );
}

function SignIn() {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);

  // Counts down until another code can be sent.
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function send() {
    const address = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await sendCode(address);
      setEmail(address);
      setCode('');
      setStep('code');
      setWait(RESEND_AFTER_S);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the code.");
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    const digits = code.replace(/\D/g, '');
    if (digits.length < 6) {
      setError('Enter the code from the email.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // On success the app sees the new session and takes over from here.
      await verifyCode(email, digits);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign you in.");
      setBusy(false);
    }
  }

  const errorBox = error && (
    <p role="alert" className="rounded-lg bg-contra-soft px-3 py-2 text-sm font-medium text-contra">
      {error}
    </p>
  );

  if (step === 'email') {
    return (
      <>
        <div className="flex flex-col gap-2">
          <h1 className="text-[26px] leading-tight font-extrabold tracking-[-0.02em] text-navy">Keep your checks on every device</h1>
          <p className="text-[15px] leading-normal text-body">We'll email you a code. No password needed.</p>
        </div>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor="email" className="text-[13px] font-semibold text-body">
            Email
          </label>
          <input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="h-12 rounded-xl border border-dash bg-white px-3 text-base text-ink placeholder:text-muted"
          />
          {errorBox}
          <button
            type="submit"
            disabled={busy || !email.trim()}
            className="h-12 cursor-pointer rounded-xl bg-navy text-base font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? 'Sending…' : 'Email me a code'}
          </button>
        </form>
        <p className="mt-auto text-center text-xs leading-relaxed text-muted">
          You never need an account to check a post. We only use your email to sign you in.
        </p>
      </>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-[26px] leading-tight font-extrabold tracking-[-0.02em] text-navy">Check your email</h1>
        <p className="text-[15px] leading-normal text-body">
          Enter the code we sent to <span className="font-semibold text-ink">{email}</span>.
        </p>
      </div>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void verify();
        }}
      >
        <label htmlFor="code" className="text-[13px] font-semibold text-body">
          Code
        </label>
        <input
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={10}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          placeholder="123456"
          className="h-14 rounded-xl border border-dash bg-white px-3 text-center text-2xl font-bold tracking-[0.3em] text-ink placeholder:font-normal placeholder:tracking-[0.3em] placeholder:text-dash"
        />
        {errorBox}
        <button
          type="submit"
          disabled={busy || code.length < 6}
          className="h-12 cursor-pointer rounded-xl bg-navy text-base font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            setStep('email');
            setError(null);
          }}
          className="min-h-11 cursor-pointer text-sm font-semibold text-body"
        >
          Use a different email
        </button>
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || wait > 0}
          className="min-h-11 cursor-pointer text-sm font-semibold text-teal-dark disabled:cursor-default disabled:text-muted"
        >
          {wait > 0 ? `Resend in ${wait}s` : 'Resend code'}
        </button>
      </div>
      <p className="text-xs leading-relaxed text-muted">Not there? Check spam. The code expires in an hour.</p>
    </>
  );
}
