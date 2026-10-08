// Run in the runtime image: node dist/tests/browser.integration.js (no model/network calls).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserContext } from 'playwright';
import { BrowserSession } from '../src/browser/session.js';
import { DEFAULT_TIMEOUTS } from '../src/timeouts.js';
import { DIRECTORY_URL } from '../src/domain.js';
import { signEvidence } from '../src/evidence.js';
import { assertUrl } from '../src/browser/proxy.js';

async function fixture(html: string, snapshotMs = 20_000, options: {
  pages?: Record<string, string>; responseDelaysMs?: Record<string, number>;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'browser-regression-'));
  const session = new BrowserSession({ jobId: 'browser-test', attempt: 1, mawb: '176-12345678',
    evidenceDir: dir, signingKey: 'test-only',
    timeouts: { ...DEFAULT_TIMEOUTS, snapshotMs } });
  try {
    await session.start();
    const context = (session as unknown as { context: BrowserContext }).context;
    // Fulfill locally after the same request validation used by the production route.
    await context.route('**/*', async route => {
      try {
        assertUrl(route.request().url());
      } catch { await route.abort('blockedbyclient'); return; }
      const body = route.request().url() === DIRECTORY_URL ? html : options.pages?.[route.request().url()];
      if (body === undefined) { await route.abort(); return; }
      const responseDelay = options.responseDelaysMs?.[route.request().url()];
      if (responseDelay) await delay(responseDelay);
      await route.fulfill({ contentType: route.request().url().endsWith('.js') ? 'application/javascript' : 'text/html', body });
    });
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

test('an asynchronous Track direct popup returns airline evidence and usable controls', async () => {
  const airline = 'https://eskycargo.emirates.com/tracking';
  const f = await fixture(`<button onclick="setTimeout(() => window.open('${airline}', '_blank'), 200)">Track direct</button>`, 20_000, {
    pages: { [airline]: '<h1>Airline tracking</h1><input aria-label="AWB">' },
  });
  try {
    const result = await f.session.click(refFor(f.opened.text, 'Track direct'), undefined, true);
    assert.equal(result.url, airline);
    assert.match(result.text, /Airline tracking/);
    const saved = JSON.parse(await readFile(join(f.dir, `${result.evidenceId}.json`), 'utf8'));
    assert.equal(saved.evidence.url, airline);
    assert.equal(saved.signature, signEvidence(saved.evidence, 'test-only'));
    const filled = await f.session.fill(refFor(result.text, 'AWB'), '176-12345678');
    assert.match(filled.text, /"value":"176-12345678"/);
    assert.equal(filled.url, airline);
  } finally { await f.cleanup(); }
});

test('a popup opened as about:blank is read only after its airline navigation', async () => {
  const airline = 'https://airline.example/tracking';
  const f = await fixture(`<button onclick="const p=window.open('about:blank', '_blank');setTimeout(() => p.location.href='${airline}', 200)">Open tracking</button>`, 20_000, {
    pages: { [airline]: '<h1>Shipment ready</h1>' },
  });
  try {
    const result = await f.session.click(refFor(f.opened.text, 'Open tracking'), { text: 'Shipment ready' }, true);
    assert.equal(result.url, airline);
    assert.match(result.text, /Shipment ready/);
  } finally { await f.cleanup(); }
});

test('a slow airline popup uses the navigation budget instead of a fixed ten seconds', async () => {
  const airline = 'https://airline.example/tracking';
  const f = await fixture(`<button onclick="setTimeout(() => window.open('${airline}', '_blank'), 100)">Track direct</button>`, 20_000, {
    pages: { [airline]: '<h1>Shipment ready</h1>' }, responseDelaysMs: { [airline]: 10_100 },
  });
  try {
    const result = await f.session.click(refFor(f.opened.text, 'Track direct'), { text: 'Shipment ready' }, true);
    assert.equal(result.url, airline);
    assert.match(result.text, /Shipment ready/);
  } finally { await f.cleanup(); }
});

test('Enter submission can wait for a new airline window', async () => {
  const airline = 'https://airline.example/tracking';
  const f = await fixture(`<form action="${airline}" target="_blank" method="post"><input aria-label="AWB" name="awb"></form>`, 20_000, {
    pages: { [airline]: '<h1>Shipment ready</h1>' },
  });
  try {
    const filled = await f.session.fill(refFor(f.opened.text, 'AWB'), '176-12345678');
    const result = await f.session.press(refFor(filled.text, 'AWB'), 'Enter', { text: 'Shipment ready' }, true);
    assert.equal(result.url, airline);
    assert.match(result.text, /Shipment ready/);
  } finally { await f.cleanup(); }
});

test('new windows still reject private, metadata and HTTP destinations', async t => {
  for (const destination of ['https://127.0.0.1/', 'https://169.254.169.254/', 'https://100.100.100.200/', 'http://airline.example/tracking']) {
    await t.test(destination, async () => {
      const f = await fixture(`<a href="${destination}" target="_blank">Open tracking</a>`, 20_000, {
        pages: { [destination]: '<h1>Must not be loaded</h1>' },
      });
      try {
        await assert.rejects(f.session.click(refFor(f.opened.text, 'Open tracking'), undefined, true));
        const evidence = await Promise.all((await readdir(f.dir)).filter(n => n.endsWith('.json'))
          .map(async name => JSON.parse(await readFile(join(f.dir, name), 'utf8')).evidence));
        assert.ok(evidence.every(e => e.url === DIRECTORY_URL));
      } finally { await f.cleanup(); }
    });
  }
});

test('directory links and third-party scripts and frames need no domain configuration', async () => {
  const airline = 'https://freight.qantas.com/tracking';
  const f = await fixture(`<a href="${airline}" target="_blank">Track direct</a>`, 20_000, {
    pages: {
      [airline]: '<p id="status"></p><script src="https://assets.example/widget.js"></script><iframe src="https://challenge.example/frame"></iframe>',
      'https://assets.example/widget.js': 'document.querySelector("#status").textContent="External script loaded";',
      'https://challenge.example/frame': '<p>Challenge frame loaded</p>',
    },
  });
  try {
    const result = await f.session.click(refFor(f.opened.text, 'Track direct'), undefined, true);
    assert.equal(result.url, airline);
    assert.match(result.text, /External script loaded/);
    assert.match(result.text, /Challenge frame loaded/);
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
