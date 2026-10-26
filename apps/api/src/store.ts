import { createHash } from 'node:crypto';
import { cleanPostText, type CheckResult } from '@hypecheck/check-core';

// Saves checks to Supabase and reuses recent results for the same post.
// Talks to Supabase's REST API with fetch, so the bundled serverless file has no extra dependencies.
//
// Settings (in .env locally, and in Vercel's Environment Variables):
//   SUPABASE_URL          https://<project>.supabase.co
//   SUPABASE_SECRET_KEY   the secret key (sb_secret_...). Server only: never put it in the web app.
// Without both, checks still work; nothing is saved.

export type CheckSource = 'paste' | 'screenshot' | 'share' | 'cli';

export interface SavedPost {
  result: CheckResult;
  extractor: string;
  version: number;
  checkedAt: string;
}

export interface CheckStore {
  findPost(hash: string): Promise<SavedPost | null>;
  savePost(post: { hash: string; text: string; result: CheckResult; extractor: string; version: number }): Promise<void>;
  logCheck(entry: { postHash: string; source: CheckSource; device: string | null; cached: boolean }): Promise<void>;
}

/** Same post, same hash: cleaned the way the pipeline cleans it, then case and spacing ignored. */
export function hashPost(text: string): string {
  const normalized = cleanPostText(text).toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

/** Accept only the random id the web app makes; anything else is dropped. */
export function cleanDeviceId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(value) ? value : null;
}

export function createSupabaseStore(env: Record<string, string | undefined>): CheckStore | null {
  const url = env.SUPABASE_URL?.replace(/\/+$/, '');
  const key = env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;

  const deployEnv = env.VERCEL_ENV ?? 'development';
  const headers: Record<string, string> = { apikey: key, 'content-type': 'application/json' };
  // Older projects use a JWT service_role key, which also goes in Authorization.
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;

  async function rest(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Supabase ${init.method ?? 'GET'} ${path.split('?')[0]} failed (${res.status}): ${body.slice(0, 300)}`);
    }
    return res;
  }

  return {
    async findPost(hash) {
      const res = await rest(`posts?hash=eq.${hash}&select=result,extractor,version,checked_at&limit=1`);
      const rows = (await res.json()) as { result: CheckResult; extractor: string; version: number; checked_at: string }[];
      const row = rows[0];
      return row ? { result: row.result, extractor: row.extractor, version: row.version, checkedAt: row.checked_at } : null;
    },

    async savePost({ hash, text, result, extractor, version }) {
      await rest('posts?on_conflict=hash', {
        method: 'POST',
        headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          hash,
          text,
          tickers: result.tickers,
          result,
          extractor,
          version,
          checked_at: new Date().toISOString(),
        }),
      });
    },

    async logCheck({ postHash, source, device, cached }) {
      await rest('checks', {
        method: 'POST',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ post_hash: postHash, source, device, cached, env: deployEnv }),
      });
    },
  };
}
