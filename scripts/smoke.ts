import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const base = process.env.FLIGHT_SERVICE_URL ?? 'http://127.0.0.1:8080';
const key = process.env.FLIGHT_SERVICE_KEY ?? Object.values(JSON.parse(readFileSync(process.env.SERVICE_API_KEYS_FILE ?? 'secrets/service-api-keys.json', 'utf8')))[0] as string;
const mawb = process.argv[2];
if (!mawb) throw new Error('Usage: npm run smoke -- 176-65598013 (executes a real, billable lookup)');
const headers = { Authorization: `Bearer ${key}`, 'X-User-Id': 'deployment-smoke', 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() };
const request = async (path: string, options: RequestInit = {}) => {
  const response = await fetch(`${base}${path}`, { ...options, headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Service returned HTTP ${response.status}`);
  return response.json();
};
const batch = await request('/v1/batches', { method: 'POST', body: JSON.stringify({ mawbs: [mawb] }) });
console.log('Batch:', batch.id);
const deadline = Date.now() + 20 * 60 * 1000;
let last = '';
while (Date.now() < deadline) {
  const current = await request(`/v1/batches/${batch.id}`);
  const progress = current.jobs.map((j: any) => ({ id: j.id, status: j.status, stage: j.stage, attempt: j.attempt }));
  if (JSON.stringify(progress) !== last) { console.log(JSON.stringify(progress)); last = JSON.stringify(progress); }
  if (current.status === 'finished') {
    console.log(JSON.stringify(current, null, 2));
    if (!['succeeded', 'partial'].includes(current.jobs[0].status) || !current.jobs[0].result?.summary.atd.value || !current.jobs[0].result?.summary.ata.value) process.exitCode = 1;
    break;
  }
  await delay(3000);
}
if (Date.now() >= deadline) { console.error('Polling timed out; server job continues. Batch:', batch.id); process.exitCode = 1; }
