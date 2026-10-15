import type { CheckResult } from '@hypecheck/check-core';

// Empty in dev (Vite proxies /api). Set VITE_API_URL when the API is hosted elsewhere.
const BASE = import.meta.env.VITE_API_URL ?? '';

export type Mode = 'live' | 'demo';

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

export async function checkPost(text: string): Promise<CheckResult> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch {
    throw new Error("Can't reach HypeCheck. Check your connection and try again.");
  }

  const data = (await res.json().catch(() => null)) as (CheckResult & { error?: string }) | null;
  if (!res.ok || !data) {
    throw new Error(data?.error ?? "The check couldn't be completed. Try again in a minute.");
  }
  return data;
}
