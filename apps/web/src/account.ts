import type { CheckResult } from '@hypecheck/check-core';
import type { HistoryEntry } from './storage';
import { supabase } from './supabase';

// Sign-in with an emailed code, and syncing history and followed tickers to the account.
// Sync is best-effort: if a call fails, the app keeps working from this device's copy.

const MAX_HISTORY = 50;

// ---------- Sign-in ----------

function friendly(error: { message?: string; status?: number } | null, fallback: string): Error {
  const message = error?.message ?? '';
  if (/rate limit|only request this after|too many/i.test(message) || error?.status === 429) {
    return new Error('Too many codes requested. Wait a minute, then try again.');
  }
  if (/expired|invalid|not found/i.test(message)) {
    return new Error("That code didn't work. Check it, or send a new one.");
  }
  if (/email/i.test(message) && /valid|format/i.test(message)) {
    return new Error('Enter a valid email address.');
  }
  return new Error(fallback);
}

export async function sendCode(email: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) throw friendly(error, "Couldn't send the code. Try again in a minute.");
}

export async function verifyCode(email: string, code: string): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' });
  if (error) throw friendly(error, "Couldn't sign you in. Try again in a minute.");
}

export async function signOut(): Promise<void> {
  // 'local' signs out this device only; other devices stay signed in.
  await supabase.auth.signOut({ scope: 'local' });
}

// ---------- History ----------

interface HistoryRow {
  id: string;
  post_hash: string;
  created_at: string;
  posts: { text: string; result: CheckResult } | { text: string; result: CheckResult }[] | null;
}

/** The account's history, newest first, in the same shape as this device's history. */
export async function fetchHistory(): Promise<HistoryEntry[]> {
  const { data, error } = await supabase
    .from('history')
    .select('id, post_hash, created_at, posts(text, result)')
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY);
  if (error) throw error;

  const entries: HistoryEntry[] = [];
  for (const row of (data ?? []) as unknown as HistoryRow[]) {
    const post = Array.isArray(row.posts) ? row.posts[0] : row.posts;
    if (!post) continue;
    entries.push({ id: `acct-${row.id}`, text: post.text, result: post.result, savedAt: row.created_at, hash: row.post_hash, synced: true });
  }
  return entries;
}

export async function addHistory(userId: string, hashes: string[]): Promise<void> {
  if (hashes.length === 0) return;
  const rows = [...new Set(hashes)].map((post_hash) => ({ user_id: userId, post_hash }));
  const { error } = await supabase.from('history').upsert(rows, { onConflict: 'user_id,post_hash', ignoreDuplicates: true });
  if (error) throw error;
}

export async function removeHistory(hash: string): Promise<void> {
  // The database only lets a user delete their own rows.
  const { error } = await supabase.from('history').delete().eq('post_hash', hash);
  if (error) throw error;
}

export async function clearHistory(userId: string): Promise<void> {
  const { error } = await supabase.from('history').delete().eq('user_id', userId);
  if (error) throw error;
}

/**
 * Combines this device's history with the account's.
 * - Entries checked while signed out (not yet synced) are kept and were just uploaded.
 * - Synced entries the account no longer has were deleted on another device, so they're dropped.
 * - Account entries this device doesn't have are added.
 */
export function mergeHistory(local: HistoryEntry[], remote: HistoryEntry[], uploaded: Set<string>): HistoryEntry[] {
  const remoteHashes = new Set(remote.map((e) => e.hash));
  const kept = local
    .filter((e) => !(e.synced && e.hash && !remoteHashes.has(e.hash)))
    .map((e) => (e.hash && (remoteHashes.has(e.hash) || uploaded.has(e.hash)) ? { ...e, synced: true } : e));
  const localHashes = new Set(kept.map((e) => e.hash).filter(Boolean));
  const added = remote.filter((e) => !localHashes.has(e.hash));
  return [...kept, ...added].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1)).slice(0, MAX_HISTORY);
}

// ---------- Followed tickers ----------

export async function fetchFollows(): Promise<string[]> {
  const { data, error } = await supabase.from('follows').select('ticker').order('created_at');
  if (error) throw error;
  return ((data ?? []) as { ticker: string }[]).map((r) => r.ticker);
}

export async function addFollows(userId: string, tickers: string[]): Promise<void> {
  if (tickers.length === 0) return;
  const rows = [...new Set(tickers)].map((ticker) => ({ user_id: userId, ticker }));
  const { error } = await supabase.from('follows').upsert(rows, { onConflict: 'user_id,ticker', ignoreDuplicates: true });
  if (error) throw error;
}

export async function removeFollow(ticker: string): Promise<void> {
  const { error } = await supabase.from('follows').delete().eq('ticker', ticker);
  if (error) throw error;
}
