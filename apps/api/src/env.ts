import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Load KEY=VALUE lines from the repo's root .env, without overriding real environment variables. */
export function loadEnv(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const file = resolve(root, '.env');
  if (!existsSync(file)) return;

  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || line.trim().startsWith('#')) continue;
    const key = match[1]!;
    const value = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[key] === undefined && value !== '') process.env[key] = value;
  }
}
