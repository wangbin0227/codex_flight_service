import { z } from 'zod';

export const DEFAULT_TIMEOUTS = {
  mcpStartupMs: 60_000, mcpToolMs: 90_000, browserLaunchMs: 45_000,
  navigationMs: 45_000, waitMs: 30_000, snapshotMs: 20_000, proxyIdleMs: 60_000,
};
export type Timeouts = typeof DEFAULT_TIMEOUTS;

export function readTimeouts(env: NodeJS.ProcessEnv): Timeouts {
  const seconds = (name: string, fallbackMs: number, max: number) =>
    z.coerce.number().int().min(1).max(max).default(fallbackMs / 1000).parse(env[name]) * 1000;
  const value = {
    mcpStartupMs: seconds('MCP_STARTUP_TIMEOUT_SECONDS', DEFAULT_TIMEOUTS.mcpStartupMs, 180),
    mcpToolMs: seconds('MCP_TOOL_TIMEOUT_SECONDS', DEFAULT_TIMEOUTS.mcpToolMs, 300),
    browserLaunchMs: seconds('BROWSER_LAUNCH_TIMEOUT_SECONDS', DEFAULT_TIMEOUTS.browserLaunchMs, 120),
    navigationMs: seconds('BROWSER_NAVIGATION_TIMEOUT_SECONDS', DEFAULT_TIMEOUTS.navigationMs, 120),
    waitMs: seconds('BROWSER_WAIT_TIMEOUT_SECONDS', DEFAULT_TIMEOUTS.waitMs, 120),
    snapshotMs: seconds('BROWSER_SNAPSHOT_TIMEOUT_SECONDS', DEFAULT_TIMEOUTS.snapshotMs, 60),
    proxyIdleMs: seconds('BROWSER_PROXY_IDLE_TIMEOUT_SECONDS', DEFAULT_TIMEOUTS.proxyIdleMs, 180),
  };
  if (value.mcpStartupMs < value.browserLaunchMs + 10_000) {
    throw new Error('MCP_STARTUP_TIMEOUT_SECONDS must allow browser launch plus 10 seconds.');
  }
  // Click + DOM readiness take up to 20s before an optional result wait and snapshot.
  // Keep another 10s for protocol overhead and the server-side cancellation deadline.
  if (value.mcpToolMs < Math.max(value.navigationMs, 20_000 + value.waitMs) + value.snapshotMs + 10_000) {
    throw new Error('MCP_TOOL_TIMEOUT_SECONDS must cover navigation/action, result wait, snapshot and 10 seconds of overhead.');
  }
  if (value.proxyIdleMs < Math.max(value.navigationMs, value.waitMs)) {
    throw new Error('BROWSER_PROXY_IDLE_TIMEOUT_SECONDS must cover navigation and result waits.');
  }
  return value;
}
