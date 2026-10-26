import type { CheckResult } from '@hypecheck/check-core';

// Guest storage: everything lives in this browser only. When accounts arrive,
// these entries are what gets uploaded to the user's account on first sign-in.

export interface HistoryEntry {
  id: string;
  text: string;
  result: CheckResult;
  savedAt: string;
}

const HISTORY_KEY = 'hypecheck.history.v1';
const TICKERS_KEY = 'hypecheck.tickers.v1';
const DEVICE_KEY = 'hypecheck.device.v1';
const MAX_ENTRIES = 50;

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

export function newEntry(text: string, result: CheckResult): HistoryEntry {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, result, savedAt: new Date().toISOString() };
}

export function loadFollowed(): string[] {
  const list = read<string[]>(TICKERS_KEY, []);
  return Array.isArray(list) ? list.filter((t) => typeof t === 'string') : [];
}

export function saveFollowed(list: string[]): void {
  write(TICKERS_KEY, list);
}
