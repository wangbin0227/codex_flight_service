import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BrowserSession, type BrowserSettings } from './session.js';

// Configuration arrives over a per-job inherited environment, never from website content.
const settings = JSON.parse(process.env.FLIGHT_BROWSER_SETTINGS ?? '{}') as BrowserSettings;
if (!settings.jobId || !settings.signingKey) throw new Error('Missing per-job browser configuration');
const session = new BrowserSession(settings);
const server = new McpServer({ name: 'flight-browser', version: '0.1.0' });
async function respond(fn: () => ReturnType<BrowserSession['snapshot']>) {
  try {
    const { image, ...value } = await fn();
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) },
      ...(image ? [{ type: 'image' as const, data: image.toString('base64'), mimeType: 'image/png' }] : [])] };
  } catch (error) {
    // Do not expose arbitrary browser errors (possibly containing URLs with credentials).
    const detail = error instanceof Error ? error.message.match(/net::[A-Z_]+|Timeout \d+ms exceeded/)?.[0] : undefined;
    const message = error instanceof Error && /budget|reference|AWB|track-trace|approved|Unsupported/.test(error.message)
      ? error.message : `Browser action failed${detail ? ` (${detail})` : ''}. Navigation attempts are recorded. Read a snapshot, retry once, or open the official airline fallback.`;
    return { isError: true, content: [{ type: 'text' as const, text: message }] };
  }
}
server.tool('browser_open', 'Open an approved HTTPS tracking page. The first page MUST be track-trace. Returns evidence and element references.', { url: z.string().url() }, ({ url }) => respond(() => session.open(url)));
server.tool('browser_snapshot', 'Read page and input values. Saves immutable evidence; use screenshot for visual inspection.', { screenshot: z.boolean().default(false) }, ({ screenshot }) => respond(() => session.snapshot(screenshot)));
server.tool('browser_click', 'Click a current element reference, then return updated page. Tracking/navigation actions only.', { ref: z.string() }, ({ ref }) => respond(() => session.click(ref)));
server.tool('browser_fill', 'Fill the current AWB, prefix, or number. Does not accept arbitrary user data.', { ref: z.string(), value: z.string() }, ({ ref, value }) => respond(() => session.fill(ref, value)));
server.tool('browser_press', 'Press Enter, Tab, ArrowDown, or Escape on a current element.', { ref: z.string(), key: z.enum(['Enter', 'Tab', 'ArrowDown', 'Escape']) }, ({ ref, key }) => respond(() => session.press(ref, key)));
server.tool('browser_select', 'Select a native tracking form dropdown option.', { ref: z.string(), value: z.string().max(100) }, ({ ref, value }) => respond(() => session.select(ref, value)));
server.tool('browser_wait', 'Wait up to 15 seconds for expected visible text; use for dynamically loaded results.', { text: z.string().min(1).max(100) }, ({ text }) => respond(() => session.wait(text)));
server.tool('browser_read_more', 'Read a later character range when snapshot text was truncated. Returns a new evidence ID.', { start: z.number().int().min(0).max(490000) }, ({ start }) => respond(() => session.read(start)));
let closing = false;
async function close() { if (closing) return; closing = true; await session.close(); await server.close(); process.exit(0); }
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close()); process.stdin.on('end', () => void close());
await session.start();
await server.connect(new StdioServerTransport());
