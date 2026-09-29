import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from './store.js';
import { validateShipment } from './evidence.js';
import { ExecutionError, type Runner } from './runtime/runner.js';
import type { JobStatus } from './domain.js';

export class Worker {
  readonly id = randomUUID();
  private active = new Set<AbortController>();
  private stopping = false;
  constructor(readonly store: Store, readonly runner: Runner) {}
  async tick(): Promise<boolean> {
    if (this.stopping) return false;
    this.store.workerAlive(this.id);
    const job = this.store.claim(`${this.id}:${randomUUID()}`);
    if (!job) return false;
    const controller = new AbortController(); this.active.add(controller);
    const heartbeat = setInterval(() => {
      try { if (!this.store.heartbeat(job)) controller.abort(); } catch { controller.abort(); }
    }, 2000);
    heartbeat.unref();
    try {
      const run = await this.runner.run(job, controller.signal, message => this.store.stage(job, message));
      this.store.stage(job, '正在校验实际时间和来源');
      const result = validateShipment(job.mawb, run.raw, run.evidence);
      const status: JobStatus = result.status === 'complete' ? 'succeeded' : result.status;
      this.store.finish(job, status, result);
    } catch (error) {
      const code = this.stopping ? 'worker_shutdown' : error instanceof ExecutionError ? error.code : 'execution_failed';
      this.store.finish(job, 'failed', null, code, this.stopping || (error instanceof ExecutionError && error.retryable));
    } finally { clearInterval(heartbeat); this.active.delete(controller); }
    return true;
  }
  async run() {
    const ping = setInterval(() => this.store.workerAlive(this.id), 5000); ping.unref();
    try {
      await Promise.all(Array.from({ length: this.store.config.concurrency }, async () => {
        while (!this.stopping) {
          try { if (!await this.tick()) await delay(500); }
          catch { console.error(JSON.stringify({ event: 'worker_iteration_failed' })); await delay(1000); }
        }
      }));
    } finally { clearInterval(ping); }
  }
  stop() { this.stopping = true; for (const controller of this.active) controller.abort(); }
}
