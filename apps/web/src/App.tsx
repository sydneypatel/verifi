import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { cleanPostText } from '@verifi/check-core';
import {
  addFollows,
  addHistory,
  clearHistory,
  fetchFollows,
  fetchHistory,
  mergeHistory,
  removeFollow,
  removeHistory,
  signOut,
} from './account';
import { checkPost, getMode, readScreenshot, type Mode } from './api';
import { Account } from './components/Account';
import { History } from './components/History';
import { Home } from './components/Home';
import { Receipt } from './components/Receipt';
import { Results } from './components/Results';
import { Tickers } from './components/Tickers';
import { TabBar, type Tab } from './components/ui';
import { shrinkImage } from './image';
import {
  loadFollowed,
  loadHistory,
  loadSyncedUser,
  newEntry,
  saveFollowed,
  saveHistory,
  saveSyncedUser,
  type HistoryEntry,
} from './storage';
import { supabase } from './supabase';

type View =
  | { name: 'home' }
  | { name: 'results'; entryId: string; from: Tab }
  | { name: 'receipt'; entryId: string; index: number; from: Tab }
  | { name: 'history' }
  | { name: 'tickers' }
  | { name: 'account'; from: Tab };

function tabOf(view: View): Tab {
  if (view.name === 'history' || view.name === 'tickers') return view.name;
  if (view.name === 'home') return 'check';
  return view.from;
}

function viewFor(tab: Tab): View {
  if (tab === 'check') return { name: 'home' };
  if (tab === 'history') return { name: 'history' };
  return { name: 'tickers' };
}

// Sync errors never interrupt the person; this device's copy keeps working.
const logSyncError = (error: unknown) => console.error('Verifi sync:', error);

export function App() {
  const [view, setView] = useState<View>({ name: 'home' });
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set while a screenshot is being read, and after, until the text is cleared.
  const [reading, setReading] = useState(false);
  const [fromScreenshot, setFromScreenshot] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [followed, setFollowed] = useState<string[]>(loadFollowed);
  const [session, setSession] = useState<Session | null>(null);

  const userId = session?.user.id ?? null;
  const email = session?.user.email ?? null;

  // The sync below reads the latest lists without re-running when they change.
  const historyRef = useRef(history);
  const followedRef = useRef(followed);
  historyRef.current = history;
  followedRef.current = followed;

  useEffect(() => {
    getMode().then(setMode);
  }, []);

  useEffect(() => saveHistory(history), [history]);
  useEffect(() => saveFollowed(followed), [followed]);

  // Each screen starts at the top.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

  // Follow sign-in and sign-out. Supabase keeps the session in this browser and refreshes it.
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  // After signing in from the account screen, go back to where the person came from.
  const previousUser = useRef<string | null>(null);
  useEffect(() => {
    if (!previousUser.current && userId) setView((v) => (v.name === 'account' ? viewFor(v.from) : v));
    previousUser.current = userId;
  }, [userId]);

  // Sync with the account whenever someone is signed in (on sign-in and on every app open).
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const firstSyncHere = loadSyncedUser() !== userId;
      const [remote, remoteFollows] = await Promise.all([fetchHistory(), fetchFollows()]);

      // Upload checks made on this device that the account doesn't have yet.
      const remoteHashes = new Set(remote.map((e) => e.hash));
      const pending = [
        ...new Set(historyRef.current.filter((e) => e.hash && !e.synced && !remoteHashes.has(e.hash)).map((e) => e.hash!)),
      ];
      await addHistory(userId, pending);

      // On the first sign-in on this device, keep tickers followed as a guest. After that,
      // the account is the source of truth, so unfollowing on another device sticks.
      const guestFollows = firstSyncHere ? followedRef.current.filter((t) => !remoteFollows.includes(t)) : [];
      await addFollows(userId, guestFollows);

      if (cancelled) return;
      setHistory((current) => mergeHistory(current, remote, new Set(pending)));
      setFollowed([...remoteFollows, ...guestFollows]);
      saveSyncedUser(userId);
    })().catch(logSyncError);
    return () => {
      cancelled = true;
    };
  }, [userId]);

  function changeText(next: string) {
    setText(next);
    // Edits keep the screenshot tag (fixing a misread is the point); clearing drops it.
    if (!next.trim()) setFromScreenshot(false);
  }

  async function readScreenshotFile(file: Blob) {
    if (reading || loading) return;
    setReading(true);
    setError(null);
    try {
      const image = await shrinkImage(file);
      const postText = await readScreenshot(image);
      setText(postText);
      setFromScreenshot(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The screenshot couldn't be read.");
    } finally {
      setReading(false);
    }
  }

  async function submit() {
    if (loading || reading || !text.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const cleaned = cleanPostText(text);
      const { result, postHash } = await checkPost(cleaned, fromScreenshot ? 'screenshot' : 'paste');
      const entry = newEntry(cleaned, result, postHash);
      setHistory((h) => [entry, ...h]);
      setView({ name: 'results', entryId: entry.id, from: 'check' });
      if (userId && postHash) {
        addHistory(userId, [postHash])
          .then(() => setHistory((h) => h.map((e) => (e.id === entry.id ? { ...e, synced: true } : e))))
          .catch(logSyncError);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  function deleteEntry(id: string) {
    const target = history.find((e) => e.id === id);
    const rest = history.filter((e) => e.id !== id);
    setHistory(rest);
    // The account keeps one row per post, so only remove it once no copy is left here.
    if (userId && target?.hash && !rest.some((e) => e.hash === target.hash)) removeHistory(target.hash).catch(logSyncError);
  }

  function restoreEntry(restored: HistoryEntry, index: number) {
    setHistory((h) => (h.some((e) => e.id === restored.id) ? h : [...h.slice(0, index), restored, ...h.slice(index)]));
    if (userId && restored.hash) addHistory(userId, [restored.hash]).catch(logSyncError);
  }

  function clearAll() {
    setHistory([]);
    if (userId) clearHistory(userId).catch(logSyncError);
  }

  function follow(ticker: string) {
    setFollowed((f) => (f.includes(ticker) ? f : [...f, ticker]));
    if (userId) addFollows(userId, [ticker]).catch(logSyncError);
  }

  function unfollow(ticker: string) {
    setFollowed((f) => f.filter((x) => x !== ticker));
    if (userId) removeFollow(ticker).catch(logSyncError);
  }

  async function handleSignOut() {
    // Everything is in the account, so nothing personal is left on a shared device.
    setHistory([]);
    setFollowed([]);
    saveSyncedUser(null);
    setView({ name: 'home' });
    await signOut();
  }

  function selectTab(tab: Tab) {
    setView(viewFor(tab));
  }

  const openAccount = () => setView({ name: 'account', from: tabOf(view) });

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
  } else if (view.name === 'account') {
    screen = <Account email={email} onBack={() => selectTab(view.from)} onSignOut={handleSignOut} />;
  } else if (view.name === 'history') {
    screen = (
      <History
        entries={history}
        email={email}
        onOpenAccount={openAccount}
        onOpen={(id) => setView({ name: 'results', entryId: id, from: 'history' })}
        onDelete={deleteEntry}
        onRestore={restoreEntry}
        onClear={clearAll}
      />
    );
  } else if (view.name === 'tickers') {
    screen = (
      <Tickers
        entries={history}
        followed={followed}
        onFollow={follow}
        onUnfollow={unfollow}
        onOpenClaim={(entryId, index) => setView({ name: 'receipt', entryId, index, from: 'tickers' })}
      />
    );
  } else {
    screen = (
      <Home
        text={text}
        onTextChange={changeText}
        onScreenshot={readScreenshotFile}
        reading={reading}
        fromScreenshot={fromScreenshot}
        onSubmit={submit}
        email={email}
        onOpenAccount={openAccount}
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
