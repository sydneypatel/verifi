import type { CheckResult, TickerSnapshot } from '@verifi/check-core';
import { getDeviceId } from './storage';

// Empty in dev (Vite proxies /api). Set VITE_API_URL when the API is hosted elsewhere.
const BASE = import.meta.env.VITE_API_URL ?? '';

export type Mode = 'live' | 'demo';

export interface CheckResponse {
  result: CheckResult;
  /** The server's id for this post, used to save it to an account. Null when nothing was saved. */
  postHash: string | null;
}

/** Whether the server checks real SEC filings or the made-up demo company. */
export async function getMode(): Promise<Mode | null> {
  try {
    const res = await fetch(`${BASE}/api/check`);
    const data = (await res.json()) as { mode?: Mode };
    return data.mode ?? null;
  } catch {
    return null;
  }
}

/** Where the post text came from, for the check log. */
export type PostSource = 'paste' | 'screenshot';

/** Copy the post text out of a screenshot. Nothing is checked or saved yet; the screenshot is not kept. */
export async function readScreenshot(image: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image }),
    });
  } catch {
    throw new Error("Can't reach Verifi. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => null)) as { text?: unknown; error?: string } | null;
  if (!res.ok || typeof data?.text !== 'string') {
    throw new Error(data?.error ?? "The screenshot couldn't be read. Try again, or paste the text.");
  }
  return data.text;
}

/** postedAt: when the post was written ("Nov 9", "2d ago"), so "today" in it is read against that day. */
export async function checkPost(text: string, source: PostSource = 'paste', postedAt?: string): Promise<CheckResponse> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/check`, {
      method: 'POST',
      // The device id is a random value from this browser, so the server can tell
      // "5 checks from 5 phones" apart from "5 checks from one phone".
      headers: { 'content-type': 'application/json', 'x-verifi-device': getDeviceId() },
      body: JSON.stringify({ text, source, ...(postedAt?.trim() ? { postedAt: postedAt.trim() } : {}) }),
    });
  } catch {
    throw new Error("Can't reach Verifi. Check your connection and try again.");
  }

  const data = (await res.json().catch(() => null)) as (CheckResult & { error?: string; postHash?: string | null }) | null;
  if (!res.ok || !data) {
    throw new Error(data?.error ?? "The check couldn't be completed. Try again in a minute.");
  }
  const { postHash, error: _error, ...result } = data;
  return { result, postHash: typeof postHash === 'string' ? postHash : null };
}

/** Today's cards for followed tickers. Sorted so every phone following the same list shares one cached answer. */
export async function fetchSnapshots(tickers: string[]): Promise<TickerSnapshot[]> {
  const list = [...new Set(tickers)].sort().slice(0, 12);
  if (list.length === 0) return [];
  const res = await fetch(`${BASE}/api/check?tickers=${encodeURIComponent(list.join(','))}`);
  const data = (await res.json().catch(() => null)) as { snapshots?: TickerSnapshot[]; error?: string } | null;
  if (!res.ok || !Array.isArray(data?.snapshots)) throw new Error(data?.error ?? "Couldn't load today's numbers.");
  return data.snapshots;
}
