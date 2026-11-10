import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { InputError } from '@verifi/check-core';
import { NotConfiguredError, createChecker } from './checker';
import { loadEnv } from './env';
import { cleanDeviceId, cleanSource } from './store';

// The one endpoint every client calls:
//   POST /api/check   { "text": "<post>", "source"?: "screenshot" }  ->  CheckResult plus postHash (or null)
//   POST /api/check   { "image": "data:image/jpeg;base64,..." }     ->  { text, platform } read from a screenshot
//   GET  /api/check?tickers=AAPL,NVDA                              ->  { snapshots } for followed tickers
// Plain node:http keeps this portable. To deploy as a serverless function,
// call checker.check() from the platform's handler instead of this server.

loadEnv();

const fixtures = process.argv.includes('--fixtures');
const checker = createChecker({ fixtures, env: process.env });
const port = Number(process.env.PORT) || 8787;
// Matches Vercel's 4.5 MB request cap, so local and deployed behave the same.
const MAX_BODY_BYTES = 4.5 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-verifi-device, x-hypecheck-device',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new InputError('That request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? '').split('?')[0];

  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && path === '/api/health') return send(res, 200, { ok: true, mode: checker.describe() });
  if (req.method === 'GET' && path === '/api/check') {
    const tickers = new URL(req.url ?? '/', 'http://x').searchParams.get('tickers');
    if (!tickers) return send(res, 200, { ok: true, mode: fixtures ? 'demo' : 'live' });
    try {
      return send(res, 200, { snapshots: await checker.snapshots(tickers) });
    } catch (error) {
      if (error instanceof InputError) return send(res, 400, { error: error.message });
      console.error(error);
      return send(res, 500, { error: "Couldn't load ticker data. Try again in a minute." });
    }
  }
  if (req.method !== 'POST' || path !== '/api/check') return send(res, 404, { error: 'Not found' });

  try {
    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (error) {
      if (error instanceof InputError) throw error;
      throw new InputError('Send JSON like {"text": "..."}');
    }
    const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    if ('image' in body) return send(res, 200, await checker.readScreenshot(body.image));

    const text = body.text;
    if (typeof text !== 'string') throw new InputError('Send JSON like {"text": "..."}');

    const device = cleanDeviceId(req.headers['x-verifi-device'] ?? req.headers['x-hypecheck-device']);
    const { result, postHash } = await checker.check(text, { source: cleanSource(body.source), device });
    send(res, 200, { ...result, postHash });
  } catch (error) {
    if (error instanceof InputError) return send(res, 400, { error: error.message });
    if (error instanceof NotConfiguredError) return send(res, 503, { error: error.message });
    console.error(error);
    send(res, 500, { error: "The check couldn't be completed. Try again in a minute." });
  }
});

server.listen(port, () => {
  console.log(`Verifi API on http://localhost:${port}  (${checker.describe()})`);
});
