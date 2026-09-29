// Client waiting budgets only. Reconnecting never cancels or restarts server work.
export class PollBudget {
  private last: number;
  private queued = true;
  queueMs = 0; executionMs = 0;
  constructor(readonly queueLimitMs: number, readonly executionLimitMs: number, now = Date.now()) { this.last = now; }
  observe(queued: boolean, now = Date.now()) {
    const elapsed = Math.max(0, now - this.last);
    if (this.queued) this.queueMs += elapsed; else this.executionMs += elapsed;
    this.last = now; this.queued = queued;
    return this.queueMs >= this.queueLimitMs ? 'queue' : this.executionMs >= this.executionLimitMs ? 'execution' : null;
  }
}
