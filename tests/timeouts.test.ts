import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig } from '../src/config.js';
import { PollBudget } from '../scripts/poll-budget.js';

test('timeout configuration rejects nested budgets that would cut off browser work', () => {
  const config = readConfig({}, false);
  assert.equal(config.jobTimeoutMs, 600_000);
  assert.equal(config.timeouts.mcpToolMs, 90_000);
  for (const env of [
    { MCP_TOOL_TIMEOUT_SECONDS: '45' }, { MCP_STARTUP_TIMEOUT_SECONDS: '35' },
    { BROWSER_NAVIGATION_TIMEOUT_SECONDS: '90' }, { BROWSER_PROXY_IDLE_TIMEOUT_SECONDS: '20' },
    { BROWSER_SNAPSHOT_TIMEOUT_SECONDS: '0' }, { MCP_TOOL_TIMEOUT_SECONDS: 'NaN' },
  ]) assert.throws(() => readConfig(env, false));
  const custom = readConfig({ MCP_TOOL_TIMEOUT_SECONDS: '150', BROWSER_NAVIGATION_TIMEOUT_SECONDS: '90',
    BROWSER_PROXY_IDLE_TIMEOUT_SECONDS: '120' }, false);
  assert.equal(custom.timeouts.navigationMs, 90_000);
});

test('client queue waiting and execution use independent budgets, including retry queue time', () => {
  const minute = 60_000, budget = new PollBudget(30 * minute, 30 * minute, 0);
  assert.equal(budget.observe(false, 20 * minute), null); // First run starts after a queue wait.
  assert.equal(budget.observe(true, 30 * minute), null); // First 600s attempt ends.
  assert.equal(budget.observe(false, 30 * minute + 5000), null); // Retry backoff.
  assert.equal(budget.observe(false, 40 * minute + 5000), null); // Second 600s attempt.
  assert.equal(budget.executionMs, 20 * minute);
  assert.equal(budget.queueMs, 20 * minute + 5000);
  assert.equal(budget.observe(false, 50 * minute + 5000), 'execution');
  const queued = new PollBudget(minute, 30 * minute, 0);
  assert.equal(queued.observe(true, minute), 'queue');
});
