import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { normalizeMawb, parseMawbs, ServiceError, terminalStatuses, type Job, type JobStatus, type ValidatedShipment } from './domain.js';

type Row = Record<string, any>;
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly config: Config) {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(config.dataDir, 'service.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, idem TEXT NOT NULL, request_hash TEXT NOT NULL,
        duplicates INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(owner, idem));
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), owner TEXT NOT NULL,
        mawb TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL, available_at INTEGER NOT NULL, lease_until INTEGER,
        worker_id TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, stage TEXT NOT NULL,
        result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, available_at);
      CREATE INDEX IF NOT EXISTS jobs_batch ON jobs(batch_id, created_at);
      CREATE INDEX IF NOT EXISTS batches_owner ON batches(owner, created_at);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id),
        attempt INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_job ON events(job_id, id);
      CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT PRIMARY KEY, n INTEGER NOT NULL, expires INTEGER NOT NULL);
      PRAGMA user_version=1;`);
  }
  close() { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(jobId: string, attempt: number, kind: string, message: string) {
    this.db.prepare('INSERT INTO events(job_id,attempt,kind,message,created_at) VALUES(?,?,?,?,?)')
      .run(jobId, attempt, kind, message.slice(0, 500), new Date().toISOString());
  }
  private row(row: Row): Job {
    return { id: row.id, batchId: row.batch_id, owner: row.owner, mawb: row.mawb, status: row.status,
      attempt: row.attempt, maxAttempts: row.max_attempts, availableAt: row.available_at,
      leaseUntil: row.lease_until, workerId: row.worker_id, cancelRequested: Boolean(row.cancel_requested),
      stage: row.stage, result: row.result_json ? JSON.parse(row.result_json) : null,
      errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  getJob(id: string, owner?: string): Job {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id=?${owner ? ' AND owner=?' : ''}`).get(...(owner ? [id, owner] : [id]));
    if (!row) throw new ServiceError(404, 'not_found', '任务不存在。');
    return this.row(row);
  }
  createBatch(owner: string, idem: string, input: string | string[]) {
    const { values, duplicates } = parseMawbs(input);
    const hash = createHash('sha256').update(JSON.stringify(values)).digest('hex');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM batches WHERE owner=? AND idem=?').get(owner, idem);
      if (existing) {
        if (existing.request_hash !== hash) throw new ServiceError(409, 'idempotency_conflict', '相同幂等键对应不同提单列表。');
        return { batch: this.getBatch(String(existing.id), owner), reused: true };
      }
      const count = (extra: string, args: string[] = []) => Number(this.db.prepare(
        `SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running') ${extra}`).get(...args)!.n);
      if (count('') + values.length > this.config.maxQueued || count('AND owner=?', [owner]) + values.length > this.config.maxOwnerQueued) {
        throw new ServiceError(429, 'queue_full', '查询队列已满，请稍后再试。');
      }
      const id = randomUUID(), now = new Date().toISOString();
      this.db.prepare('INSERT INTO batches VALUES(?,?,?,?,?,?)').run(id, owner, idem, hash, duplicates, now);
      const insert = this.db.prepare(`INSERT INTO jobs(id,batch_id,owner,mawb,status,max_attempts,available_at,stage,error_code,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
      for (const mawb of values) {
        const valid = Boolean(normalizeMawb(mawb)), jobId = randomUUID();
        insert.run(jobId, id, owner, mawb, valid ? 'queued' : 'invalid_input', this.config.maxAttempts,
          Date.now(), valid ? '排队中' : '提单号格式有误', valid ? null : 'invalid_input', now, now);
        this.event(jobId, 0, valid ? 'queued' : 'invalid_input', valid ? '已进入查询队列' : '应为三位前缀加八位号码');
      }
      return { batch: this.getBatch(id, owner), reused: false };
    });
  }
  getBatch(id: string, owner: string) {
    const batch = this.db.prepare('SELECT * FROM batches WHERE id=? AND owner=?').get(id, owner);
    if (!batch) throw new ServiceError(404, 'not_found', '批次不存在。');
    const jobs = this.db.prepare('SELECT * FROM jobs WHERE batch_id=? ORDER BY rowid').all(id).map(r => this.row(r));
    const finished = jobs.filter(j => terminalStatuses.includes(j.status)).length;
    return { id, createdAt: batch.created_at, duplicates: batch.duplicates, total: jobs.length, finished,
      status: finished === jobs.length ? 'finished' : jobs.some(j => j.status === 'running') ? 'running' : 'queued', jobs };
  }
  listBatches(owner: string, limit: number, offset: number) {
    return this.db.prepare('SELECT id FROM batches WHERE owner=? ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(owner, limit, offset).map(r => this.getBatch(String(r.id), owner));
  }
  claim(workerId: string, now = Date.now()): Job | null {
    return this.transaction(() => {
      for (const old of this.db.prepare("SELECT * FROM jobs WHERE status='running' AND lease_until<?").all(now)) {
        const status = old.cancel_requested ? 'cancelled' : Number(old.attempt) < Number(old.max_attempts) ? 'queued' : 'failed';
        this.db.prepare('UPDATE jobs SET status=?,worker_id=NULL,lease_until=NULL,stage=?,error_code=?,updated_at=? WHERE id=?')
          .run(status, status === 'queued' ? '执行中断，等待重试' : '执行中断', 'worker_lost', new Date().toISOString(), old.id!);
        this.event(String(old.id), Number(old.attempt), 'worker_lost', '任务租约过期，已按重试预算恢复');
      }
      const running = Number(this.db.prepare("SELECT count(*) n FROM jobs WHERE status='running'").get()!.n);
      if (running >= this.config.concurrency) return null;
      const row = this.db.prepare(`SELECT j.* FROM jobs j WHERE j.status='queued' AND j.available_at<=?
        AND NOT EXISTS(SELECT 1 FROM jobs r WHERE r.status='running' AND substr(r.mawb,1,3)=substr(j.mawb,1,3))
        ORDER BY j.available_at,j.rowid LIMIT 1`).get(now);
      if (!row) return null;
      this.db.prepare(`UPDATE jobs SET status='running',attempt=attempt+1,worker_id=?,lease_until=?,stage=?,
        error_code=NULL,updated_at=? WHERE id=?`).run(workerId, now + this.config.leaseMs, '正在启动查询', new Date().toISOString(), row.id!);
      const job = this.getJob(String(row.id));
      this.event(job.id, job.attempt, 'started', '正在启动 Codex 与独立浏览器');
      return job;
    });
  }
  heartbeat(job: Job): boolean {
    return Boolean(this.db.prepare(`UPDATE jobs SET lease_until=? WHERE id=? AND status='running' AND worker_id=? AND attempt=?
      AND cancel_requested=0 AND lease_until>?`).run(Date.now() + this.config.leaseMs, job.id, job.workerId, job.attempt, Date.now()).changes);
  }
  stage(job: Job, stage: string) {
    const changed = this.db.prepare(`UPDATE jobs SET stage=?,updated_at=? WHERE id=? AND status='running' AND worker_id=? AND attempt=? AND lease_until>?`)
      .run(stage, new Date().toISOString(), job.id, job.workerId, job.attempt, Date.now()).changes;
    if (changed) this.event(job.id, job.attempt, 'progress', stage);
  }
  finish(job: Job, status: JobStatus, result: ValidatedShipment | null, errorCode: string | null = null, retryable = false) {
    return this.transaction(() => {
      const current = this.getJob(job.id);
      if (current.status !== 'running' || current.workerId !== job.workerId || current.attempt !== job.attempt || (current.leaseUntil ?? 0) <= Date.now()) return false;
      const retry = !current.cancelRequested && retryable && current.attempt < current.maxAttempts;
      const finalStatus = current.cancelRequested ? 'cancelled' : retry ? 'queued' : status;
      const stage = finalStatus === 'queued' ? '暂时失败，等待重试' : finalStatus === 'cancelled' ? '已取消' : result ? '查询已完成' : '查询失败';
      this.db.prepare(`UPDATE jobs SET status=?,result_json=?,error_code=?,stage=?,worker_id=NULL,lease_until=NULL,available_at=?,updated_at=? WHERE id=?`)
        .run(finalStatus, current.cancelRequested ? null : result ? JSON.stringify(result) : null, errorCode, stage,
          Date.now() + (retry ? 5000 * job.attempt : 0), new Date().toISOString(), job.id);
      this.event(job.id, job.attempt, finalStatus, stage);
      return true;
    });
  }
  cancelBatch(id: string, owner: string) {
    return this.transaction(() => {
      this.getBatch(id, owner);
      const rows = this.db.prepare("SELECT * FROM jobs WHERE batch_id=? AND status IN ('queued','running')").all(id);
      for (const row of rows) {
        this.db.prepare(`UPDATE jobs SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
          stage=CASE WHEN status='queued' THEN '已取消' ELSE '取消中' END,updated_at=? WHERE id=?`).run(new Date().toISOString(), row.id!);
        this.event(String(row.id), Number(row.attempt), 'cancel_requested', '已请求取消');
      }
      return this.getBatch(id, owner);
    });
  }
  retryJob(id: string, owner: string) {
    return this.transaction(() => {
      const job = this.getJob(id, owner);
      if (!['partial', 'not_found', 'blocked', 'failed', 'cancelled'].includes(job.status)) {
        throw new ServiceError(409, 'not_retryable', '当前状态不能重试。');
      }
      if (job.attempt >= 6) throw new ServiceError(409, 'attempt_limit', '此任务已达 6 次执行上限，请创建新批次。');
      const queued = Number(this.db.prepare("SELECT count(*) n FROM jobs WHERE status IN ('queued','running')").get()!.n);
      const ownerQueued = Number(this.db.prepare("SELECT count(*) n FROM jobs WHERE owner=? AND status IN ('queued','running')").get(owner)!.n);
      if (queued >= this.config.maxQueued || ownerQueued >= this.config.maxOwnerQueued) throw new ServiceError(429, 'queue_full', '查询队列已满。');
      this.db.prepare(`UPDATE jobs SET status='queued',cancel_requested=0,result_json=NULL,error_code=NULL,
        max_attempts=?,available_at=?,stage='等待重查',updated_at=? WHERE id=?`)
        .run(Math.min(6, job.attempt + this.config.maxAttempts), Date.now(), new Date().toISOString(), id);
      this.event(id, job.attempt, 'retry_requested', '已加入重查队列');
      return this.getJob(id, owner);
    });
  }
  events(id: string, owner: string, after: number) {
    this.getJob(id, owner);
    return this.db.prepare('SELECT id,attempt,kind,message,created_at AS createdAt FROM events WHERE job_id=? AND id>? ORDER BY id LIMIT 200').all(id, after);
  }
  workerAlive(id: string) {
    this.db.prepare('INSERT INTO workers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at').run(id, Date.now());
    this.db.prepare('DELETE FROM workers WHERE updated_at<?').run(Date.now() - 300_000);
  }
  ready() { return Boolean(this.db.prepare('SELECT 1 FROM workers WHERE updated_at>? LIMIT 1').get(Date.now() - 30_000)); }
  rateLimit(bucket: string, limit: number): boolean {
    const minute = Math.floor(Date.now() / 60000), key = `${bucket}:${minute}`;
    this.db.prepare('DELETE FROM rate_limits WHERE expires<?').run(Date.now());
    const row = this.db.prepare(`INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET n=n+1 RETURNING n`)
      .get(key, (minute + 1) * 60000);
    return Number(row!.n) <= limit;
  }
}
