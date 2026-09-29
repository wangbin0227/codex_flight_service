// Run in the runtime image: node dist/tests/browser.integration.js (no model/network calls).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { BrowserSession } from '../src/browser/session.js';
import { DEFAULT_TIMEOUTS } from '../src/timeouts.js';
import { DIRECTORY_URL } from '../src/domain.js';
import { signEvidence } from '../src/evidence.js';

async function fixture(html: string, snapshotMs = 20_000) {
  const dir = await mkdtemp(join(tmpdir(), 'browser-regression-'));
  const session = new BrowserSession({ jobId: 'browser-test', attempt: 1, mawb: '176-12345678',
    evidenceDir: dir, signingKey: 'test-only', allowedHosts: ['track-trace.com'],
    timeouts: { ...DEFAULT_TIMEOUTS, snapshotMs } });
  try {
    await session.start();
    const context = (session as unknown as { context: BrowserContext }).context;
    // Latest Playwright route wins; all fixture pages are fulfilled locally.
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    const opened = await session.open(DIRECTORY_URL);
    return { session, dir, page: context.pages()[0]!, opened,
      cleanup: async () => { await session.close(); await rm(dir, { recursive: true, force: true }); } };
  } catch (error) { await session.close(); await rm(dir, { recursive: true, force: true }); throw error; }
}
function refFor(text: string, label: string) {
  const line = text.split('\n').find(line => line.startsWith('[') && line.includes(`"label":"${label}"`));
  assert.ok(line, `Missing control ${label}`);
  return line.match(/^\[([^\]]+)\]/)![1]!;
}

test('batched snapshot keeps visible controls, frame text, actionable references and signed evidence', async () => {
  const f = await fixture(`<title>Tracking fixture</title><input style="display:none" aria-label="Hidden field">
    <input aria-label="Doc.No."><button style="visibility:hidden">Hidden button</button>
    ${Array.from({ length: 170 }, (_, i) => `<button>Control ${i}</button>`).join('')}
    <iframe srcdoc="<p>Secondary frame cargo record</p><button>Frame control</button>"></iframe>`);
  try {
    assert.match(f.opened.text, /Secondary frame cargo record/);
    assert.doesNotMatch(f.opened.text, /"label":"Hidden/);
    const filled = await f.session.fill(refFor(f.opened.text, 'Doc.No.'), '17612345678');
    assert.equal(await f.page.getByLabel('Doc.No.').inputValue(), '17612345678');
    assert.match(filled.text, /"value":"17612345678"/);
    const saved = JSON.parse(await readFile(join(f.dir, `${filled.evidenceId}.json`), 'utf8'));
    assert.equal(saved.signature, signEvidence(saved.evidence, 'test-only'));
    await assert.rejects(f.session.click(refFor(f.opened.text, 'Control 0')), /Stale element reference/);
  } finally { await f.cleanup(); }
});

test('batched control references retain Playwright shadow-DOM ordering', async () => {
  const f = await fixture(`<div id="host"></div><input aria-label="Light input">
    <script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<input aria-label="Shadow input">'</script>`);
  try {
    const next = await f.session.fill(refFor(f.opened.text, 'Shadow input'), '17612345678');
    assert.equal(await f.page.getByLabel('Shadow input').inputValue(), '17612345678');
    assert.equal(await f.page.getByLabel('Light input').inputValue(), '');
    await f.session.fill(refFor(next.text, 'Light input'), '176-12345678');
    assert.equal(await f.page.getByLabel('Light input').inputValue(), '176-12345678');
  } finally { await f.cleanup(); }
});

test('AJAX submissions wait for result text or loader disappearance, not DOM readiness', async () => {
  const f = await fixture(`<button onclick="document.querySelector('#loading').hidden=false;document.querySelector('#result').textContent='';setTimeout(()=>{document.querySelector('#loading').hidden=true;document.querySelector('#result').textContent='Shipment result ready'},350)">Search</button>
    <p id="loading" hidden>Loading shipment</p><p id="result"></p>`);
  try {
    const result = await f.session.click(refFor(f.opened.text, 'Search'), { text: 'Shipment result ready' });
    assert.match(result.text, /Shipment result ready/);
    const again = await f.session.click(refFor(result.text, 'Search'), { text: 'Loading shipment', state: 'hidden' });
    assert.match(again.text, /Shipment result ready/);
    assert.equal(await f.page.getByText('Loading shipment').isVisible(), false);
    f.session.settings.timeouts!.waitMs = 100;
    await assert.rejects(f.session.wait('Result that never arrives'), /Timeout/);
    assert.match((await f.session.snapshot()).text, /Shipment result ready/);
  } finally { await f.cleanup(); }
});

test('snapshot deadline kills a stalled renderer and prevents late evidence or reuse', async () => {
  const f = await fixture('<p>Ready</p>');
  try {
    f.session.settings.timeouts!.snapshotMs = 250;
    const before = await readdir(f.dir);
    const stalled = f.page.evaluate(() => { while (true) { /* Simulate a hung airline page. */ } }).catch(() => {});
    const started = Date.now();
    await assert.rejects(f.session.snapshot(), /Timeout 250ms exceeded/);
    assert.ok(Date.now() - started < 3000);
    await f.session.close(); await stalled;
    assert.equal(f.page.isClosed(), true);
    await assert.rejects(f.session.snapshot(), /session closed/);
    assert.deepEqual(await readdir(f.dir), before);
  } finally { await f.cleanup(); }
});

test('MCP cancellation closes browser and overlapping tool calls are rejected', async () => {
  const f = await fixture('<p>Ready</p>');
  try {
    const controller = new AbortController();
    const pending = f.session.runTool(() => f.page.waitForTimeout(60_000), controller.signal);
    await assert.rejects(f.session.runTool(() => f.session.snapshot()), /already in progress/);
    controller.abort();
    await assert.rejects(pending, /cancellation/);
    await f.session.close(); assert.equal(f.page.isClosed(), true);
  } finally { await f.cleanup(); }
});
