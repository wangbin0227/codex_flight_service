import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

test('smoke resumes an existing batch through transient HTTP failure without resubmission', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  let reads = 0, writes = 0;
  const server = createServer((req, res) => {
    if (req.method !== 'GET') writes++;
    assert.equal(req.url, `/v1/batches/${id}`);
    reads++;
    if (reads === 2) { res.writeHead(503); res.end(); return; }
    const finished = reads >= 4;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id, status: finished ? 'finished' : reads === 3 ? 'running' : 'queued',
      jobs: [{ id: 'fixture-job', attempt: 1, status: finished ? 'succeeded' : 'running', stage: 'fixture',
        result: finished ? { summary: { atd: { value: 'original ATD' }, ata: { value: 'original ATA' } } } : null }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/smoke.ts'], { env: { ...process.env,
    FLIGHT_SERVICE_URL: `http://127.0.0.1:${address.port}`, FLIGHT_SERVICE_KEY: 'local-test-only',
    FLIGHT_BATCH_ID: id, FLIGHT_QUEUE_TIMEOUT_SECONDS: '30', FLIGHT_POLL_TIMEOUT_SECONDS: '30' } });
  let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, output); assert.equal(writes, 0);
    assert.match(output, /Polling interrupted/); assert.match(output, /original ATA/);
  } finally { clearTimeout(timer); child.kill(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
