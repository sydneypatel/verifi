import type { IncomingMessage, ServerResponse } from 'node:http';
import { InputError } from '@hypecheck/check-core';
import { NotConfiguredError, createChecker, type Checker } from './checker';
import { cleanDeviceId, cleanSource } from './store';

// The Vercel serverless version of the API. `npm run build:api` bundles this
// file and everything it imports into api/check.js, the single file Vercel runs.
//
//   GET  /api/check                          -> { ok, mode }  (the web app reads this)
//   GET  /api/check?tickers=AAPL,NVDA         -> { snapshots }: daily cards for followed tickers
//   POST /api/check  { "text": "...",        -> CheckResult plus postHash (the saved post's id, or null)
//                      "source"?: "screenshot" }
//   POST /api/check  { "image": "data:..." } -> { text, platform }: the post text read from a screenshot.
//                                               Nothing is checked or saved; the app shows the text first.
//
// Settings come from Vercel's environment variables:
//   HYPECHECK_DEMO=1     serve the made-up demo company, no SEC or LLM calls
//   SEC_USER_AGENT       required for live mode: "HypeCheck your-email@example.com"
//   ANTHROPIC_API_KEY    optional: with it, an LLM reads the post, earnings releases and screenshots
//   HYPECHECK_MODEL      optional
//   FINNHUB_API_KEY      optional: earnings vs estimates, prices, market value
//   SUPABASE_URL         optional: with SUPABASE_SECRET_KEY, checks are saved and reused
//   SUPABASE_SECRET_KEY  optional, server only

// Vercel caps a request at 4.5 MB. The app shrinks screenshots to well under 1 MB.
const MAX_BODY_BYTES = 4.5 * 1024 * 1024;

// Kept between requests while the function stays warm, so the cache is shared.
let checker: Checker | null = null;

type VercelRequest = IncomingMessage & { body?: unknown };

function send(res: ServerResponse, status: number, body: unknown, cache = 'no-store'): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', cache);
  res.end(JSON.stringify(body));
}

async function readPayload(req: VercelRequest): Promise<Record<string, unknown> | null> {
  // Vercel usually parses JSON bodies already.
  if (req.body && typeof req.body === 'object') return req.body as Record<string, unknown>;
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new InputError('That request is too large.');
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export default async function handler(req: VercelRequest, res: ServerResponse): Promise<void> {
  const demo = process.env.HYPECHECK_DEMO === '1';

  try {
    checker ??= createChecker({ fixtures: demo, env: process.env });
  } catch (error) {
    // Usually a missing SEC_USER_AGENT; the message says how to fix it.
    return send(res, 500, { error: error instanceof Error ? error.message : 'Server is not configured.' });
  }

  if (req.method === 'GET') {
    const tickers = new URL(req.url ?? '/', 'http://x').searchParams.get('tickers');
    if (!tickers) return send(res, 200, { ok: true, mode: demo ? 'demo' : 'live' });
    try {
      // Vercel's edge keeps each ticker list for 10 minutes, so many phones cost one set of Finnhub calls.
      return send(res, 200, { snapshots: await checker.snapshots(tickers) }, 'public, s-maxage=600, stale-while-revalidate=1800');
    } catch (error) {
      if (error instanceof InputError) return send(res, 400, { error: error.message });
      console.error(error);
      return send(res, 500, { error: "Couldn't load ticker data. Try again in a minute." });
    }
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });

  try {
    const payload = await readPayload(req);
    if (payload && 'image' in payload) {
      return send(res, 200, await checker.readScreenshot(payload.image));
    }
    const text = payload?.text;
    if (typeof text !== 'string') throw new InputError('Send JSON like {"text": "..."}');
    const device = cleanDeviceId(req.headers['x-hypecheck-device']);
    const { result, postHash } = await checker.check(text, { source: cleanSource(payload?.source), device });
    send(res, 200, { ...result, postHash });
  } catch (error) {
    if (error instanceof InputError) return send(res, 400, { error: error.message });
    if (error instanceof NotConfiguredError) return send(res, 503, { error: error.message });
    console.error(error);
    send(res, 500, { error: "The check couldn't be completed. Try again in a minute." });
  }
}
