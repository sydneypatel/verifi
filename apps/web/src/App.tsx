import { useEffect, useState } from 'react';
import { cleanPostText } from '@hypecheck/check-core';
import { checkPost, getMode, type Mode } from './api';
import { History } from './components/History';
import { Home } from './components/Home';
import { Receipt } from './components/Receipt';
import { Results } from './components/Results';
import { Tickers } from './components/Tickers';
import { TabBar, type Tab } from './components/ui';
import { loadFollowed, loadHistory, newEntry, saveFollowed, saveHistory, type HistoryEntry } from './storage';

type View =
  | { name: 'home' }
  | { name: 'results'; entryId: string; from: Tab }
  | { name: 'receipt'; entryId: string; index: number; from: Tab }
  | { name: 'history' }
  | { name: 'tickers' };

function tabOf(view: View): Tab {
  if (view.name === 'history' || view.name === 'tickers') return view.name;
  if (view.name === 'home') return 'check';
  return view.from;
}

export function App() {
  const [view, setView] = useState<View>({ name: 'home' });
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [followed, setFollowed] = useState<string[]>(loadFollowed);

  useEffect(() => {
    getMode().then(setMode);
  }, []);

  useEffect(() => saveHistory(history), [history]);
  useEffect(() => saveFollowed(followed), [followed]);

  // Each screen starts at the top.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

  async function submit() {
    if (loading || !text.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const cleaned = cleanPostText(text);
      const result = await checkPost(cleaned);
      const entry = newEntry(cleaned, result);
      setHistory((h) => [entry, ...h]);
      setView({ name: 'results', entryId: entry.id, from: 'check' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  function selectTab(tab: Tab) {
    if (tab === 'check') setView({ name: 'home' });
    else if (tab === 'history') setView({ name: 'history' });
    else setView({ name: 'tickers' });
  }

  const entry = view.name === 'results' || view.name === 'receipt' ? history.find((e) => e.id === view.entryId) : undefined;

  let screen;
  if (view.name === 'results' && entry) {
    screen = (
      <Results
        text={entry.text}
        result={entry.result}
        onBack={() => selectTab(view.from)}
        onOpenClaim={(index) => setView({ name: 'receipt', entryId: entry.id, index, from: view.from })}
      />
    );
  } else if (view.name === 'receipt' && entry) {
    screen = (
      <Receipt
        result={entry.result}
        index={view.index}
        onBack={() => setView({ name: 'results', entryId: entry.id, from: view.from })}
        onNext={() => setView({ ...view, index: view.index + 1 })}
      />
    );
  } else if (view.name === 'history') {
    screen = (
      <History
        entries={history}
        onOpen={(id) => setView({ name: 'results', entryId: id, from: 'history' })}
        onDelete={(id) => setHistory((h) => h.filter((e) => e.id !== id))}
        onRestore={(restored, index) =>
          setHistory((h) => (h.some((e) => e.id === restored.id) ? h : [...h.slice(0, index), restored, ...h.slice(index)]))
        }
        onClear={() => setHistory([])}
      />
    );
  } else if (view.name === 'tickers') {
    screen = (
      <Tickers
        entries={history}
        followed={followed}
        onFollow={(t) => setFollowed((f) => (f.includes(t) ? f : [...f, t]))}
        onUnfollow={(t) => setFollowed((f) => f.filter((x) => x !== t))}
        onOpenClaim={(entryId, index) => setView({ name: 'receipt', entryId, index, from: 'tickers' })}
      />
    );
  } else {
    screen = (
      <Home
        text={text}
        onTextChange={setText}
        onSubmit={submit}
        onOpenHistory={() => selectTab('history')}
        loading={loading}
        error={error}
        mode={mode}
      />
    );
  }

  return (
    // Phone-first: one column, capped at phone width on larger screens.
    <div className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col bg-ground shadow-[0_0_0_1px_var(--color-line)]">
      <main className="flex flex-1 flex-col">{screen}</main>
      <TabBar active={tabOf(view)} onSelect={selectTab} />
    </div>
  );
}
