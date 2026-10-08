import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { captchaActionSchema } from './captcha.js';
import { BrowserSession, type BrowserSettings } from './session.js';

// Configuration arrives over a per-job inherited environment, never from website content.
const settings = JSON.parse(process.env.FLIGHT_BROWSER_SETTINGS ?? '{}') as BrowserSettings;
if (!settings.jobId || !settings.signingKey) throw new Error('Missing per-job browser configuration');
const session = new BrowserSession(settings);
const server = new McpServer({ name: 'flight-browser', version: '0.1.0' });
const waitCondition = z.object({ text: z.string().min(1).max(100), state: z.enum(['visible', 'hidden']).default('visible') });
async function respond(fn: () => ReturnType<BrowserSession['snapshot']>, signal: AbortSignal) {
  try {
    const { image, ...value } = await session.runTool(fn, signal);
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) },
      ...(image ? [{ type: 'image' as const, data: image.toString('base64'), mimeType: 'image/png' }] : [])] };
  } catch (error) {
    // Do not expose arbitrary browser errors (possibly containing URLs with credentials).
    const detail = error instanceof Error ? error.message.match(/net::[A-Z_]+|Timeout \d+ms exceeded/)?.[0] : undefined;
    const message = session.isClosed
      ? `Browser session closed after cancellation or timeout${detail ? ` (${detail})` : ''}. End this attempt with tool_failure; further calls cannot reuse this session.`
      : error instanceof Error && /budget|reference|AWB|track-trace|public HTTPS|Unsupported|^CAPTCHA|Browser operation already/.test(error.message)
      ? error.message : `Browser action failed${detail ? ` (${detail})` : ''}. Navigation attempts are recorded. Read a snapshot, retry once, or open the official airline fallback.`;
    return { isError: true, content: [{ type: 'text' as const, text: message }] };
  }
}
server.tool('browser_open', 'Open a public HTTPS tracking page. The first page MUST be track-trace; follow the directory and airline links for the current AWB. Returns evidence and element references.', { url: z.string().url() }, ({ url }, extra) => respond(() => session.open(url), extra.signal));
server.tool('browser_snapshot', 'Read page and input values. Saves immutable evidence; use screenshot for visual inspection.', { screenshot: z.boolean().default(false) }, ({ screenshot }, extra) => respond(() => session.snapshot(screenshot), extra.signal));
server.tool('browser_click', 'Click a current element reference. Set newPage=true when the action opens a new tab/window (including Track direct); waits for that page and returns its snapshot. For query submissions, set waitFor to expected result/error text becoming visible or an observed loading message becoming hidden. A snapshot alone does not mean the query finished.', { ref: z.string(), waitFor: waitCondition.optional(), newPage: z.boolean().default(false) }, ({ ref, waitFor, newPage }, extra) => respond(() => session.click(ref, waitFor, newPage), extra.signal));
server.tool('browser_fill', 'Fill the current AWB, prefix, or number. Does not accept arbitrary user data.', { ref: z.string(), value: z.string() }, ({ ref, value }, extra) => respond(() => session.fill(ref, value), extra.signal));
server.tool('browser_press', 'Press Enter, Tab, ArrowDown, or Escape on a current element. Set newPage=true if submission opens a new tab/window. For submissions, use waitFor for dynamic result/error text or disappearance of an observed loading message.', { ref: z.string(), key: z.enum(['Enter', 'Tab', 'ArrowDown', 'Escape']), waitFor: waitCondition.optional(), newPage: z.boolean().default(false) }, ({ ref, key, waitFor, newPage }, extra) => respond(() => session.press(ref, key, waitFor, newPage), extra.signal));
server.tool('browser_select', 'Select a native tracking form dropdown option.', { ref: z.string(), value: z.string().max(100) }, ({ ref, value }, extra) => respond(() => session.select(ref, value), extra.signal));
server.tool('browser_wait', 'Wait for result/error text to become visible, or an observed loading message to become hidden. Default limit is 30 seconds (deployment configurable). Disappearance of loading alone is not shipment evidence.', { text: z.string().min(1).max(100), state: z.enum(['visible', 'hidden']).default('visible') }, ({ text, state }, extra) => respond(() => session.wait(text, state), extra.signal));
server.tool('browser_read_more', 'Read a later character range when snapshot text was truncated. Returns a new evidence ID.', { start: z.number().int().min(0).max(490000) }, ({ start }, extra) => respond(() => session.read(start), extra.signal));
server.tool('browser_captcha_inspect', 'Inspect a snapshot reference marked captcha:region. Returns a cropped image for visual reasoning, a single-use challengeId, exact image dimensions and allowed captcha input refs. Inspect AFTER filling the AWB. Do not snapshot between inspection and action.', { ref: z.string() }, ({ ref }, extra) => respond(() => session.captchaInspect(ref), extra.signal));
server.tool('browser_captcha_act', 'Complete ordinary visual verification: fill a listed CAPTCHA input, click within the inspected image, or drag inside that image. Coordinates use the cropped image origin, not the page. One action per challengeId; returns a fresh snapshot. Does not handle SMS, email, OTP or login. Budgets per query attempt: 3 fills, 12 clicks, 3 drags.',
  { challengeId: z.string().uuid(), action: captchaActionSchema }, ({ challengeId, action }, extra) => respond(() => session.captchaAct(challengeId, action), extra.signal));
let closing = false;
async function close() { if (closing) return; closing = true; await session.close(); await server.close(); process.exit(0); }
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close()); process.stdin.on('end', () => void close());
await session.start();
await server.connect(new StdioServerTransport());
