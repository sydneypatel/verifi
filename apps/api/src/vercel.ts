import type { IncomingMessage, ServerResponse } from 'node:http';
import { InputError } from '@hypecheck/check-core';
import { createChecker, type Checker } from './checker';
import { cleanDeviceId } from './store';

// The Vercel serverless version of the API. `npm run build:api` bundles this
// file and everything it imports into api/check.js, the single file Vercel runs.
//
//   GET  /api/check                    -> { ok, mode }  (the web app reads this)
//   POST /api/check  { "text": "..." } -> CheckResult plus postHash (the saved post's id, or null)
//
// Settings come from Vercel's environment variables:
//   HYPECHECK_DEMO=1     serve the made-up demo company, no SEC or LLM calls
//   SEC_USER_AGENT       required for live mode: "HypeCheck your-email@example.com"
//   ANTHROPIC_API_KEY    optional: with it, an LLM reads the post
//   HYPECHECK_MODEL      optional
//   SUPABASE_URL         optional: with SUPABASE_SECRET_KEY, checks are saved and reused
//   SUPABASE_SECRET_KEY  optional, server only

const MAX_BODY_BYTES = 64 * 1024;

// Kept between requests while the function stays warm, so the cache is shared.
let checker: Checker | null = null;

type VercelRequest = IncomingMessage & { body?: unknown };

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readText(req: VercelRequest): Promise<string | null> {
  // Vercel usually parses JSON bodies already.
  if (req.body && typeof req.body === 'object') {
    const text = (req.body as { text?: unknown }).text;
    return typeof text === 'string' ? text : null;
  }
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new InputError('That post is too long.');
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  try {
    const text = (JSON.parse(raw) as { text?: unknown } | null)?.text;
    return typeof text === 'string' ? text : null;
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

  if (req.method === 'GET') return send(res, 200, { ok: true, mode: demo ? 'demo' : 'live' });
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });

  try {
    const text = await readText(req);
    if (text === null) throw new InputError('Send JSON like {"text": "..."}');
    const device = cleanDeviceId(req.headers['x-hypecheck-device']);
    const { result, postHash } = await checker.check(text, { source: 'paste', device });
    send(res, 200, { ...result, postHash });
  } catch (error) {
    if (error instanceof InputError) return send(res, 400, { error: error.message });
    console.error(error);
    send(res, 500, { error: "The check couldn't be completed. Try again in a minute." });
  }
}
