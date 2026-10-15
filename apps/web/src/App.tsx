import type { CheckResult } from '@hypecheck/check-core';
import { useEffect, useState } from 'react';
import { checkPost, getMode, type Mode } from './api';
import { Home } from './components/Home';
import { Receipt } from './components/Receipt';
import { Results } from './components/Results';

type View = { name: 'home' } | { name: 'results' } | { name: 'receipt'; index: number };

export function App() {
  const [view, setView] = useState<View>({ name: 'home' });
  const [text, setText] = useState('');
  const [result, setResult] = useState<CheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);

  useEffect(() => {
    getMode().then(setMode);
  }, []);

  async function submit() {
    if (loading || !text.trim()) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await checkPost(text));
      setView({ name: 'results' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  return (
    // Phone-first: one column, capped at phone width on larger screens.
    <main className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col px-5 pt-6 pb-5">
      {view.name === 'home' || !result ? (
        <Home text={text} onTextChange={setText} onSubmit={submit} loading={loading} error={error} mode={mode} />
      ) : view.name === 'results' ? (
        <Results result={result} onBack={() => setView({ name: 'home' })} onOpenClaim={(index) => setView({ name: 'receipt', index })} />
      ) : (
        <Receipt
          result={result}
          index={view.index}
          onBack={() => setView({ name: 'results' })}
          onNext={() => setView({ name: 'receipt', index: view.index + 1 })}
        />
      )}
    </main>
  );
}
