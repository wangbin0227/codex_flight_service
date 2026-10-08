import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { createApp } from '../src/api.js';
import { Worker } from '../src/worker.js';
import { ExecutionError } from '../src/runtime/runner.js';
import { conflictingDepartureFixture, fixture, key, mawb, splitShipmentFixture, verifiedFixture } from './helpers.js';
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
test('all split arrivals persist as succeeded with the final batch ATA and every original segment', async () => {
  const f = fixture(), store = new Store(f.config), app = createApp(f.config, store);
  try {
    const created = await app.inject({ method: 'POST', url: '/v1/batches', headers, payload: { mawbs: [mawb] } });
    const batch = created.json(), sample = splitShipmentFixture();
    const worker = new Worker(store, { run: async () => ({ raw: sample.result, evidence: sample.evidence }) });
    await worker.tick();
    const job = (await app.inject({ url: `/v1/jobs/${batch.jobs[0].id}`, headers })).json();
    assert.equal(job.status, 'succeeded'); assert.equal(job.result.journeyComplete, true);
    assert.equal(job.result.summary.atd.value, '26AUG26 01:00');
    assert.equal(job.result.summary.ata.value, '29AUG26 12:06');
    assert.match(job.result.summary.ata.note, /45\/45/u);
    assert.deepEqual(job.result.segments, sample.result.segments);
  } finally { await app.close(); store.close(); f.cleanup(); }
});
test('pending actual times and warnings survive worker persistence and API responses', async () => {
  const f = fixture(), store = new Store(f.config), app = createApp(f.config, store);
  try {
    const created = await app.inject({ method: 'POST', url: '/v1/batches', headers, payload: { mawbs: [mawb] } });
    const batch = created.json(), sample = verifiedFixture(), segment = sample.result.segments[0]!;
    const oldQuote = segment.actualDeparture!.quote, quote = oldQuote.replace('EK123', 'EK/0123');
    sample.page.text = sample.page.text.replace(oldQuote, quote);
    segment.flightNumber = 'EK/0123';
    segment.actualDeparture!.quote = segment.actualArrival!.quote = quote;
    const worker = new Worker(store, { run: async () => ({ raw: sample.result, evidence: sample.evidence }) });
    await worker.tick();
    for (const job of [store.getJob(batch.jobs[0].id), (await app.inject({ url: `/v1/jobs/${batch.jobs[0].id}`, headers })).json()]) {
      assert.equal(job.status, 'partial');
      assert.equal(job.result.summary.atd.value, '01 Sep 2026 10:00');
      assert.equal(job.result.summary.ata.value, '01 Sep 2026 15:00');
      assert.match(job.result.summary.ata.note, /待核实/u);
      assert.equal(job.result.segments[0].actualArrival.quote, quote);
      assert.equal(job.result.issues.filter((i: { code: string }) => i.code === 'time_context_unverified').length, 2);
    }
  } finally { await app.close(); store.close(); f.cleanup(); }
});
test('conflict candidates reach value-and-note clients and remain partial through persistence and API reads', async () => {
  const f = fixture(), store = new Store(f.config), app = createApp(f.config, store);
  try {
    const created = await app.inject({ method: 'POST', url: '/v1/batches', headers, payload: { mawbs: [mawb] } });
    const batch = created.json(), sample = conflictingDepartureFixture();
    const worker = new Worker(store, { run: async () => ({ raw: sample.result, evidence: sample.evidence }) });
    await worker.tick();
    const detail = (await app.inject({ url: `/v1/jobs/${batch.jobs[0].id}`, headers })).json();
    const history = (await app.inject({ url: `/v1/batches/${batch.id}`, headers })).json();
    for (const job of [store.getJob(detail.id), detail, history.jobs[0]]) {
      assert.equal(job.status, 'partial'); assert.equal(job.result.status, 'partial');
      assert.equal(job.result.summary.atd.kind, 'value', 'the existing Miaoda value branch displays this candidate');
      assert.equal(job.result.summary.atd.value, '01 Sep 2026 10:00');
      assert.match(job.result.summary.atd.note, /候选.*冲突.*待核实/u);
      assert.deepEqual(job.result.issues, sample.result.issues);
      assert.deepEqual(job.result.segments, sample.result.segments);
      assert.equal(job.result.summary.ata.value, '01 Sep 2026 15:00');
    }
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
