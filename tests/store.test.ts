import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { parseMawbs } from '../src/domain.js';
import { fixture } from './helpers.js';

test('normalization preserves leading zeros, deduplicates and isolates invalid input', () => {
  assert.deepEqual(parseMawbs('０４５－５４０２６２２１，04554026221\n176 65598013 BAD'), { values: ['045-54026221', '176-65598013', 'BAD'], duplicates: 1 });
});
test('durable batches enforce ownership and idempotency across restarts', () => {
  const f = fixture(); let store = new Store(f.config);
  try {
    const first = store.createBatch('tenant:user', 'request-1', ['17665598013', 'bad']);
    const id = first.batch.id;
    assert.equal(first.batch.jobs[1]!.status, 'invalid_input');
    store.close(); store = new Store(f.config);
    assert.equal(store.createBatch('tenant:user', 'request-1', ['176-65598013', 'bad']).batch.id, id);
    assert.throws(() => store.createBatch('tenant:user', 'request-1', ['112-90239332']), /幂等/);
    assert.throws(() => store.getBatch(id, 'tenant:other'), /不存在/);
    assert.throws(() => store.getJob(first.batch.jobs[0]!.id, 'other:user'), /不存在/);
  } finally { store.close(); f.cleanup(); }
});
test('claims are exclusive across database connections and serialize each airline', () => {
  const f = fixture(), a = new Store(f.config), b = new Store(f.config);
  try {
    a.createBatch('user', 'request-1', ['17665598013', '17612345678', '11290239332']);
    const first = a.claim('one')!, second = b.claim('two')!;
    assert.equal(first.mawb, '176-65598013'); assert.equal(second.mawb, '112-90239332');
    assert.equal(a.claim('three'), null);
    a.finish(first, 'blocked', null); assert.equal(b.claim('three')!.mawb, '176-12345678');
  } finally { a.close(); b.close(); f.cleanup(); }
});
test('expired lease is recovered and stale worker cannot overwrite fresh attempt', () => {
  const f = fixture(), store = new Store(f.config);
  try {
    store.createBatch('user', 'request-1', ['17665598013']);
    const old = store.claim('old')!;
    store.db.prepare('UPDATE jobs SET lease_until=? WHERE id=?').run(Date.now() - 1000, old.id);
    const fresh = store.claim('new')!;
    assert.equal(fresh.attempt, 2);
    assert.equal(store.finish(old, 'succeeded', null), false);
    assert.equal(store.heartbeat(old), false);
    assert.equal(store.finish(fresh, 'failed', null, 'timeout', true), true);
    assert.equal(store.getJob(fresh.id).status, 'failed');
  } finally { store.close(); f.cleanup(); }
});
test('cancellation wins over late completion and retry is single-flight', () => {
  const f = fixture(), store = new Store(f.config);
  try {
    const { batch } = store.createBatch('user', 'request-1', ['17665598013', '17612345678']);
    const job = store.claim('worker')!;
    store.cancelBatch(batch.id, 'user');
    assert.equal(store.heartbeat(job), false);
    store.finish(job, 'succeeded', null);
    assert.equal(store.getJob(job.id).status, 'cancelled');
    assert.equal(store.getBatch(batch.id, 'user').finished, 2);
    store.retryJob(job.id, 'user');
    assert.throws(() => store.retryJob(job.id, 'user'), /不能重试/);
  } finally { store.close(); f.cleanup(); }
});
test('queue quota and shared rate limiter bound work', () => {
  const f = fixture(); f.config.maxOwnerQueued = 1;
  const store = new Store(f.config);
  try {
    store.createBatch('user', 'request-1', ['17665598013']);
    assert.throws(() => store.createBatch('user', 'request-2', ['11290239332']), /队列已满/);
    assert.equal(store.rateLimit('test', 1), true); assert.equal(store.rateLimit('test', 1), false);
  } finally { store.close(); f.cleanup(); }
});
