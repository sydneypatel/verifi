import type { CheckResult } from '@verifi/check-core';

// This device's copy of history and followed tickers. Guests use only this.
// Signed-in users use it too, and account.ts keeps it in sync with their account.

export interface HistoryEntry {
  id: string;
  text: string;
  result: CheckResult;
  savedAt: string;
  /** The server's id for this post. Missing for checks made before the database existed. */
  hash?: string;
  /** True once this entry is saved to the signed-in account. */
  synced?: boolean;
}

const HISTORY_KEY = 'verifi.history.v1';
const TICKERS_KEY = 'verifi.tickers.v1';
const DEVICE_KEY = 'verifi.device.v1';
const SYNCED_USER_KEY = 'verifi.synced-user.v1';
const SEEN_KEY = 'verifi.tickers-seen.v1';
const MAX_ENTRIES = 50;

// The app was called HypeCheck. Carry over anything saved under the old names, once.
try {
  for (const key of [HISTORY_KEY, TICKERS_KEY, DEVICE_KEY, SYNCED_USER_KEY, SEEN_KEY]) {
    const old = key.replace(/^verifi\./, 'hypecheck.');
    const value = localStorage.getItem(old);
    if (value !== null && localStorage.getItem(key) === null) localStorage.setItem(key, value);
  }
} catch {
  // No storage available: nothing to carry over.
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing or full storage: the app still works, history just isn't kept.
  }
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** A random id for this browser. It identifies a device for counting, never a person. */
export function getDeviceId(): string {
  const existing = read<string | null>(DEVICE_KEY, null);
  if (typeof existing === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing;
  const id = randomId();
  write(DEVICE_KEY, id);
  return id;
}

export function loadHistory(): HistoryEntry[] {
  const list = read<HistoryEntry[]>(HISTORY_KEY, []);
  return Array.isArray(list) ? list.filter((e) => e && e.id && e.result && typeof e.text === 'string') : [];
}

export function saveHistory(list: HistoryEntry[]): void {
  write(HISTORY_KEY, list.slice(0, MAX_ENTRIES));
}

export function newEntry(text: string, result: CheckResult, hash: string | null): HistoryEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    result,
    savedAt: new Date().toISOString(),
    ...(hash ? { hash } : {}),
  };
}

export function loadFollowed(): string[] {
  const list = read<string[]>(TICKERS_KEY, []);
  return Array.isArray(list) ? list.filter((t) => typeof t === 'string') : [];
}

export function saveFollowed(list: string[]): void {
  write(TICKERS_KEY, list);
}

/** The account this device last synced with. A different one means a first sign-in here. */
export function loadSyncedUser(): string | null {
  return read<string | null>(SYNCED_USER_KEY, null);
}

export function saveSyncedUser(userId: string | null): void {
  if (userId) write(SYNCED_USER_KEY, userId);
  else {
    try {
      localStorage.removeItem(SYNCED_USER_KEY);
    } catch {
      // Nothing to do.
    }
  }
}

/** The date (YYYY-MM-DD) each ticker's card was last seen here, so newer filings can be marked "New". */
export function loadSeen(): Record<string, string> {
  return read<Record<string, string>>(SEEN_KEY, {});
}

export function saveSeen(seen: Record<string, string>): void {
  write(SEEN_KEY, seen);
}
