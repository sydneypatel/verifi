import {
  MemoryCache,
  SecClient,
  checkPost,
  createAnthropicExtractor,
  createRuleBasedExtractor,
  createSecFigureSource,
  createSecRevenueSource,
  type CheckDeps,
  type CheckResult,
} from '@hypecheck/check-core';
import { createFixtureFetch } from '@hypecheck/check-core/fixtures';

export interface CheckerOptions {
  /** Serve the made-up demo company from memory instead of calling the SEC. */
  fixtures: boolean;
  env: Record<string, string | undefined>;
}

export interface Checker {
  check(text: string): Promise<CheckResult>;
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

  return {
    check: (text) => checkPost(text, deps),
    describe: () => `extractor: ${extractor.name}, data: ${fixtures ? 'demo fixtures' : 'live SEC'}`,
  };
}
