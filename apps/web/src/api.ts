import type { CheckResult } from '@hypecheck/check-core';
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

export async function checkPost(text: string): Promise<CheckResponse> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/check`, {
      method: 'POST',
      // The device id is a random value from this browser, so the server can tell
      // "5 checks from 5 phones" apart from "5 checks from one phone".
      headers: { 'content-type': 'application/json', 'x-hypecheck-device': getDeviceId() },
      body: JSON.stringify({ text }),
    });
  } catch {
    throw new Error("Can't reach HypeCheck. Check your connection and try again.");
  }

  const data = (await res.json().catch(() => null)) as (CheckResult & { error?: string; postHash?: string | null }) | null;
  if (!res.ok || !data) {
    throw new Error(data?.error ?? "The check couldn't be completed. Try again in a minute.");
  }
  const { postHash, error: _error, ...result } = data;
  return { result, postHash: typeof postHash === 'string' ? postHash : null };
}
