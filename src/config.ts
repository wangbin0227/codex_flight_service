import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

export const DEFAULT_HOSTS = [
  'track-trace.com', 'skycargo.com', 'emirates.com', 'ckair.com', 'atlasair.com',
  'csair.com', 'latamcargo.com', 'turkishcargo.com', 'champ.aero', 'mercator.com',
  'qrcargo.com', 'cathaycargo.com', 'lufthansa-cargo.com', 'saudiacargo.com',
  'cargolux.com', 'afklcargo.com', 'ethiopiancargo.com', 'etihadcargo.com',
];
const integer = (fallback: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(fallback);
export interface Config {
  dataDir: string; host: string; port: number; apiKeys: Record<string, string>;
  concurrency: number; jobTimeoutMs: number; leaseMs: number; maxAttempts: number;
  maxQueued: number; maxOwnerQueued: number; requestLimit: number;
  codexBin: string; model: string; modelApiKey: string; modelBaseUrl?: string;
  allowedHosts: string[]; browserExecutable?: string;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env, requireApiKeys = true): Config {
  const secret = (name: string): string => env[`${name}_FILE`]
    ? readFileSync(env[`${name}_FILE`]!, 'utf8').trim() : (env[name] ?? '');
  let parsedKeys: unknown;
  try { parsedKeys = JSON.parse(secret('SERVICE_API_KEYS') || '{}'); }
  catch { throw new Error('SERVICE_API_KEYS must be a valid JSON object; secret values are not logged.'); }
  const apiKeys = z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), z.string().min(32)).parse(parsedKeys);
  if ((requireApiKeys && !Object.keys(apiKeys).length) || new Set(Object.values(apiKeys)).size !== Object.keys(apiKeys).length) {
    throw new Error('SERVICE_API_KEYS must contain unique keys of at least 32 characters.');
  }
  const base = env.CODEX_BASE_URL?.replace(/\/$/, '');
  if (base) {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('CODEX_BASE_URL must be an HTTPS API base URL without credentials or query.');
    }
  }
  const hosts = (env.BROWSER_ALLOWED_HOSTS?.trim() ? env.BROWSER_ALLOWED_HOSTS.split(',') : DEFAULT_HOSTS).map(h => h.trim().toLowerCase());
  if (hosts.some(h => !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(h))) throw new Error('Invalid browser host allowlist.');
  return {
    dataDir: resolve(env.DATA_DIR ?? './runtime'), host: env.HOST ?? '127.0.0.1',
    port: integer(8080, 1, 65535).parse(env.PORT), apiKeys,
    concurrency: integer(2, 1, 8).parse(env.WORKER_CONCURRENCY),
    jobTimeoutMs: integer(240, 30, 900).parse(env.JOB_TIMEOUT_SECONDS) * 1000,
    leaseMs: 30_000, maxAttempts: integer(2, 1, 3).parse(env.MAX_ATTEMPTS),
    maxQueued: integer(1000, 1, 10000).parse(env.MAX_QUEUED),
    maxOwnerQueued: integer(200, 1, 1000).parse(env.MAX_OWNER_QUEUED),
    requestLimit: integer(120, 10, 1000).parse(env.REQUESTS_PER_MINUTE),
    codexBin: env.CODEX_BIN ? (env.CODEX_BIN.includes('/') ? resolve(env.CODEX_BIN) : env.CODEX_BIN) : resolve('node_modules/.bin/codex'),
    model: env.CODEX_MODEL ?? 'gpt-6-astra', modelApiKey: secret('CODEX_API_KEY'),
    modelBaseUrl: base, allowedHosts: hosts, browserExecutable: env.BROWSER_EXECUTABLE_PATH,
  };
}
