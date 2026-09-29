import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { createApp } from '../src/api.js';
import { Worker } from '../src/worker.js';
import { ExecutionError } from '../src/runtime/runner.js';
import { fixture, key, mawb, verifiedFixture } from './helpers.js';
const headers = { authorization: `Bearer ${key}`, 'x-user-id': 'alice', 'idempotency-key': 'batch-request-1' };

test('API to queue to worker to persisted result completes with deterministic fixture evidence', async () => {
  const f = fixture(), store = new Store(f.config), app = createApp(f.config, store);
  try {
    assert.equal((await app.inject('/healthz')).statusCode, 200);
    assert.equal((await app.inject('/v1/batches')).statusCode, 401);
    assert.equal((await app.inject({ url: '/readyz', headers })).statusCode, 503);
    const created = await app.inject({ method: 'POST', url: '/v1/batches', headers, payload: { mawbs: [mawb, 'bad'] } });
    assert.equal(created.statusCode, 202); const batch = created.json();
    const sample = verifiedFixture();
    const worker = new Worker(store, { run: async () => ({ raw: sample.result, evidence: sample.evidence }) });
    await worker.tick();
    const read = (await app.inject({ url: `/v1/batches/${batch.id}`, headers })).json();
    assert.equal(read.status, 'finished'); assert.equal(read.finished, 2);
    assert.equal(read.jobs[0].status, 'succeeded'); assert.equal(read.jobs[0].result.summary.atd.value, '01 Sep 2026 10:00');
    assert.equal('owner' in read.jobs[0], false); assert.equal('workerId' in read.jobs[0], false);
    assert.equal((await app.inject({ url: `/v1/jobs/${batch.jobs[0].id}`, headers: { ...headers, 'x-user-id': 'bob' } })).statusCode, 404);
    assert.equal((await app.inject({ url: `/v1/jobs/${batch.jobs[0].id}/evidence`, headers: { ...headers, 'x-user-id': 'bob' } })).statusCode, 404);
    assert.equal((await app.inject({ url: '/readyz', headers })).statusCode, 200);
  } finally { await app.close(); store.close(); f.cleanup(); }
});
test('API refuses arbitrary prompts, missing identity and invalid idempotency keys', async () => {
  const f = fixture(), store = new Store(f.config), app = createApp(f.config, store);
  try {
    for (const payload of [{ prompt: 'execute anything', mawbs: [mawb] }, { mawbs: [] }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/v1/batches', headers, payload })).statusCode, 400);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/v1/batches', headers: { authorization: headers.authorization }, payload: { mawbs: [mawb] } })).statusCode, 400);
  } finally { await app.close(); store.close(); f.cleanup(); }
});
test('one transient failure retries within budget and cannot stall another airline', async () => {
  const f = fixture(), store = new Store(f.config);
  try {
    const { batch } = store.createBatch('alice', 'request-1', [mawb, '11290239332']);
    const worker = new Worker(store, { run: async () => { throw new ExecutionError('query_timeout', true); } });
    await worker.tick();
    assert.equal(store.getJob(batch.jobs[0]!.id).status, 'queued');
    await worker.tick();
    assert.equal(store.getJob(batch.jobs[1]!.id).attempt, 1);
    assert.ok(store.getJob(batch.jobs[0]!.id).availableAt > Date.now());
  } finally { store.close(); f.cleanup(); }
});
