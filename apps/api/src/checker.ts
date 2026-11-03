import {
  FinnhubClient,
  MemoryCache,
  SecClient,
  checkPost,
  cleanPostText,
  createAnthropicExtractor,
  createAnthropicReleaseReader,
  createEarningsReleases,
  createFinnhubEarningsSource,
  createFinnhubMarketSource,
  createRuleBasedExtractor,
  createSecFigureSource,
  createSecRevenueSource,
  type CheckDeps,
  type CheckResult,
  type EvidenceSource,
} from '@hypecheck/check-core';
import { createFinnhubFixtureFetch, createFixtureFetch } from '@hypecheck/check-core/fixtures';
import { createSupabaseStore, hashPost, type CheckSource, type CheckStore } from './store';

// Bump this whenever verdict logic or a data source changes, so saved results
// from the old logic are recomputed instead of reused.
// 2: 8-K earnings releases, Finnhub earnings and market data, three new claim types.
// 3: fiscal labels for EPS quarters; month-to-date left out early in a month.
export const RESULT_VERSION = 3;

// A saved result is reused for the same post for this long (matches the SEC evidence cache).
const REUSE_FOR_MS = 6 * 60 * 60 * 1000;
// Prices move all day, so a result with a price or market-value check is reused only briefly.
const REUSE_MARKET_FOR_MS = 5 * 60 * 1000;

function reuseWindow(result: CheckResult): number {
  return result.claims.some((c) => c.evidence?.kind === 'market') ? REUSE_MARKET_FOR_MS : REUSE_FOR_MS;
}

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

export interface CheckOutcome {
  result: CheckResult;
  /** The saved post's id, which the app uses to add it to an account. Null when nothing was saved. */
  postHash: string | null;
}

export interface Checker {
  check(text: string, meta?: CheckMeta): Promise<CheckOutcome>;
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

  // Earnings press releases need an LLM to read them. Without a key, filings alone are used.
  const releases =
    !fixtures && env.ANTHROPIC_API_KEY
      ? createEarningsReleases({ sec, reader: createAnthropicReleaseReader({ apiKey: env.ANTHROPIC_API_KEY, model: env.HYPECHECK_MODEL }) })
      : undefined;

  // Finnhub (free tier): EPS vs estimates, prices, market value. Optional.
  const finnhub = fixtures
    ? new FinnhubClient({ apiKey: 'demo', fetch: createFinnhubFixtureFetch() })
    : env.FINNHUB_API_KEY
      ? new FinnhubClient({ apiKey: env.FINNHUB_API_KEY })
      : null;

  // Register new data sources here. The first source that supports a claim checks it.
  const sources: EvidenceSource[] = [createSecRevenueSource({ sec, releases }), createSecFigureSource({ sec, releases })];
  if (finnhub) sources.push(createFinnhubEarningsSource({ finnhub }), createFinnhubMarketSource({ finnhub }));

  const deps: CheckDeps = { extractor, sources, cache: new MemoryCache() };

  // Demo checks are never saved, so the made-up company stays out of the data.
  const store: CheckStore | null = fixtures ? null : createSupabaseStore(env);

  async function check(text: string, meta: CheckMeta = {}): Promise<CheckOutcome> {
    if (!store) return { result: await checkPost(text, deps), postHash: null };

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
      Date.now() - Date.parse(saved.checkedAt) < reuseWindow(saved.result);
    if (saved && fresh) {
      await log(true);
      return { result: saved.result, postHash: hash };
    }

    // 2. Otherwise check it, save the result, and log the check.
    const result = await checkPost(text, deps);
    try {
      await store.savePost({ hash, text: cleanPostText(text), result, extractor: extractor.name, version: RESULT_VERSION });
    } catch (error) {
      console.error(error);
      return { result, postHash: null };
    }
    await log(false);
    return { result, postHash: hash };
  }

  return {
    check,
    describe: () =>
      [
        `extractor: ${extractor.name}`,
        `data: ${fixtures ? 'demo fixtures' : 'live SEC'}`,
        `earnings releases: ${releases ? 'on' : 'off'}`,
        `market data: ${finnhub ? (fixtures ? 'demo fixtures' : 'Finnhub') : 'off (set FINNHUB_API_KEY)'}`,
        `saving: ${store ? 'Supabase' : 'off'}`,
      ].join(', '),
  };
}
