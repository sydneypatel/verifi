import {
  MemoryCache,
  SecClient,
  checkPost,
  cleanPostText,
  createAnthropicExtractor,
  createRuleBasedExtractor,
  createSecFigureSource,
  createSecRevenueSource,
  type CheckDeps,
  type CheckResult,
} from '@hypecheck/check-core';
import { createFixtureFetch } from '@hypecheck/check-core/fixtures';
import { createSupabaseStore, hashPost, type CheckSource, type CheckStore } from './store';

// Bump this whenever verdict logic or a data source changes, so saved results
// from the old logic are recomputed instead of reused.
export const RESULT_VERSION = 1;

// A saved result is reused for the same post for this long (matches the SEC evidence cache).
const REUSE_FOR_MS = 6 * 60 * 60 * 1000;

export interface CheckerOptions {
  /** Serve the made-up demo company from memory instead of calling the SEC. */
  fixtures: boolean;
  env: Record<string, string | undefined>;
}

export interface CheckMeta {
  source?: CheckSource;
  /** Random id the web app keeps in the browser, used to count distinct devices. */
  device?: string | null;
}

export interface Checker {
  check(text: string, meta?: CheckMeta): Promise<CheckResult>;
  describe(): string;
}

/** Wires the pipeline together once per process, so the cache is shared across requests. */
export function createChecker({ fixtures, env }: CheckerOptions): Checker {
  const userAgent = env.SEC_USER_AGENT;
  if (!fixtures && !userAgent) {
    throw new Error(
      'SEC_USER_AGENT is not set. Locally, add it to .env (see .env.example). On Vercel, add it under Settings > Environment Variables and redeploy. Or use demo mode (npm run dev:demo, or HYPECHECK_DEMO=1 on Vercel).',
    );
  }

  const sec = new SecClient({
    userAgent: userAgent ?? 'HypeCheck demo',
    fetch: fixtures ? createFixtureFetch() : undefined,
  });

  const extractor = env.ANTHROPIC_API_KEY
    ? createAnthropicExtractor({ apiKey: env.ANTHROPIC_API_KEY, model: env.HYPECHECK_MODEL })
    : createRuleBasedExtractor();

  const deps: CheckDeps = {
    extractor,
    // Register new data sources here.
    sources: [createSecRevenueSource({ sec }), createSecFigureSource({ sec })],
    cache: new MemoryCache(),
  };

  // Demo checks are never saved, so the made-up company stays out of the data.
  const store: CheckStore | null = fixtures ? null : createSupabaseStore(env);

  async function check(text: string, meta: CheckMeta = {}): Promise<CheckResult> {
    if (!store) return checkPost(text, deps);

    const hash = hashPost(text);
    const log = (cached: boolean) =>
      store
        .logCheck({ postHash: hash, source: meta.source ?? 'paste', device: meta.device ?? null, cached })
        .catch((error) => console.error(error));

    // 1. Same post checked recently with the same logic: reuse it (no LLM or SEC calls).
    let saved = null;
    try {
      saved = await store.findPost(hash);
    } catch (error) {
      console.error(error); // The database being down never blocks a check.
    }
    const fresh =
      saved &&
      saved.version === RESULT_VERSION &&
      saved.extractor === extractor.name &&
      Date.now() - Date.parse(saved.checkedAt) < REUSE_FOR_MS;
    if (saved && fresh) {
      await log(true);
      return saved.result;
    }

    // 2. Otherwise check it, save the result, and log the check.
    const result = await checkPost(text, deps);
    try {
      await store.savePost({ hash, text: cleanPostText(text), result, extractor: extractor.name, version: RESULT_VERSION });
      await log(false);
    } catch (error) {
      console.error(error);
    }
    return result;
  }

  return {
    check,
    describe: () =>
      `extractor: ${extractor.name}, data: ${fixtures ? 'demo fixtures' : 'live SEC'}, saving: ${store ? 'Supabase' : 'off'}`,
  };
}
