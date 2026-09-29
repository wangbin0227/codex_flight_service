import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { PollBudget } from './poll-budget.js';
const base = process.env.FLIGHT_SERVICE_URL ?? 'http://127.0.0.1:8080';
const key = process.env.FLIGHT_SERVICE_KEY ?? Object.values(JSON.parse(readFileSync(process.env.SERVICE_API_KEYS_FILE ?? 'secrets/service-api-keys.json', 'utf8')))[0] as string;
const mawb = process.argv[2];
const resumeId = process.env.FLIGHT_BATCH_ID ? z.string().uuid().parse(process.env.FLIGHT_BATCH_ID) : undefined;
if (!mawb && !resumeId) throw new Error('Usage: npm run smoke -- 176-65598013 (executes a real, billable lookup), or set FLIGHT_BATCH_ID to resume polling');
const seconds = z.coerce.number().int().min(1).max(86400).default(1800);
const budget = new PollBudget(seconds.parse(process.env.FLIGHT_QUEUE_TIMEOUT_SECONDS) * 1000,
  seconds.parse(process.env.FLIGHT_POLL_TIMEOUT_SECONDS) * 1000);
const headers = { Authorization: `Bearer ${key}`, 'X-User-Id': 'deployment-smoke', 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() };
class HttpError extends Error { constructor(readonly status: number) { super(`Service returned HTTP ${status}`); } }
const request = async (path: string, options: RequestInit = {}) => {
  const response = await fetch(`${base}${path}`, { ...options, headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new HttpError(response.status);
  return response.json();
};
const batch = resumeId ? await request(`/v1/batches/${resumeId}`)
  : await request('/v1/batches', { method: 'POST', body: JSON.stringify({ mawbs: [mawb] }) });
console.log('Batch:', batch.id);
console.log(`Resume without submitting again: FLIGHT_BATCH_ID=${batch.id} node dist/scripts/smoke.js`);
let last = '', queued = batch.status === 'queued';
budget.observe(queued);
while (true) {
  let current;
  try { current = await request(`/v1/batches/${batch.id}`); }
  catch (error) {
    if (error instanceof HttpError && ![429, 502, 503, 504].includes(error.status)) throw error;
    console.error('Polling interrupted; server job continues. Retrying the same batch.');
    if (budget.observe(queued)) { process.exitCode = 1; break; }
    await delay(error instanceof HttpError && error.status === 429 ? 60000 : 3000);
    continue;
  }
  const progress = current.jobs.map((j: any) => ({ id: j.id, status: j.status, stage: j.stage, attempt: j.attempt }));
  if (JSON.stringify(progress) !== last) { console.log(JSON.stringify(progress)); last = JSON.stringify(progress); }
  if (current.status === 'finished') {
    console.log(JSON.stringify(current, null, 2));
    if (!current.jobs.every((j: any) => ['succeeded', 'partial'].includes(j.status) && j.result?.summary.atd.value && j.result?.summary.ata.value)) process.exitCode = 1;
    break;
  }
  queued = current.status === 'queued';
  const exhausted = budget.observe(queued);
  if (exhausted) { console.error(`${exhausted} polling budget exhausted.`); process.exitCode = 1; break; }
  await delay(3000);
}
if (process.exitCode === 1) console.error('Client stopped waiting; no cancellation was sent. Resume with FLIGHT_BATCH_ID=' + batch.id);
