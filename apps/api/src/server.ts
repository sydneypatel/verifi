import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { InputError } from '@hypecheck/check-core';
import { createChecker } from './checker';
import { loadEnv } from './env';
import { cleanDeviceId } from './store';

// The one endpoint every client calls:
//   POST /api/check   { "text": "<post>" }   ->   CheckResult
// Plain node:http keeps this portable. To deploy as a serverless function,
// call checker.check() from the platform's handler instead of this server.

loadEnv();

const fixtures = process.argv.includes('--fixtures');
const checker = createChecker({ fixtures, env: process.env });
const port = Number(process.env.PORT) || 8787;
const MAX_BODY_BYTES = 64 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-hypecheck-device',
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
        reject(new InputError('That post is too long.'));
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
  if (req.method === 'GET' && path === '/api/check') return send(res, 200, { ok: true, mode: fixtures ? 'demo' : 'live' });
  if (req.method !== 'POST' || path !== '/api/check') return send(res, 404, { error: 'Not found' });

  try {
    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (error) {
      if (error instanceof InputError) throw error;
      throw new InputError('Send JSON like {"text": "..."}');
    }
    const text = (payload as { text?: unknown } | null)?.text;
    if (typeof text !== 'string') throw new InputError('Send JSON like {"text": "..."}');

    const device = cleanDeviceId(req.headers['x-hypecheck-device']);
    send(res, 200, await checker.check(text, { source: 'paste', device }));
  } catch (error) {
    if (error instanceof InputError) return send(res, 400, { error: error.message });
    console.error(error);
    send(res, 500, { error: "The check couldn't be completed. Try again in a minute." });
  }
});

server.listen(port, () => {
  console.log(`HypeCheck API on http://localhost:${port}  (${checker.describe()})`);
});
