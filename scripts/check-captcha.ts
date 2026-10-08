// Deterministic browser integration fixtures. No external sites or model credentials are used.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserContext } from 'playwright';
import { BrowserSession } from '../src/browser/session.js';
import { DIRECTORY_URL } from '../src/domain.js';
import { readEvidence } from '../src/evidence.js';

const root = await mkdtemp(join(tmpdir(), 'flight-captcha-check-'));
const jobId = randomUUID(), key = 'owned-fixture-evidence-key';
const session = new BrowserSession({ jobId, attempt: 1, mawb: '112-90239332', signingKey: key,
  evidenceDir: root });
const fixture = `<!doctype html><meta charset="utf-8"><style>body{font:20px sans-serif}canvas{display:block}#captcha-widget{position:relative;width:320px;height:100px;background:#ddd}#slider{position:absolute;left:0;top:50px;width:40px;height:40px;background:blue}#target{position:absolute;left:220px;top:50px;width:50px;height:40px;background:green}</style>
<label>AWB<input id="awb" aria-label="AWB"></label>
<div class="verify-row"><canvas id="img-verify" width="160" height="60"></canvas><input id="code-verify" aria-label="图形验证码"><button id="refresh">换图</button></div>
<input id="sms-code" aria-label="短信验证码"><button id="query">查询</button><div id="result"></div>
<div id="captcha-widget"><div id="slider" role="slider"></div><div id="target"></div></div>
<iframe title="CAPTCHA frame" src="https://challenge.example/frame"></iframe>
<script>
const image=document.getElementById('img-verify'), ctx=image.getContext('2d');let answer='A7B9';
function paint(){ctx.fillStyle='white';ctx.fillRect(0,0,160,60);ctx.fillStyle='black';ctx.font='32px sans-serif';ctx.fillText(answer,10,40)}paint();
document.getElementById('refresh').onclick=()=>{answer='C2D4';paint()};
document.getElementById('query').onclick=()=>{document.getElementById('result').textContent=document.getElementById('code-verify').value===answer&&document.getElementById('awb').value==='112-90239332'?'112-90239332 CK123 PVG BNE ATD 01 Sep 2026 10:00 ATA 01 Sep 2026 15:00':'验证码错误'};
let down=false;document.getElementById('slider').onmousedown=()=>down=true;
document.getElementById('target').onmouseup=()=>{if(down)document.getElementById('result').textContent='slider passed';down=false};
document.getElementById('target').onclick=()=>document.getElementById('result').textContent='image click passed';
</script>`;
type Snapshot = Awaited<ReturnType<BrowserSession['snapshot']>>;
const ref = (snapshot: Snapshot, label: string, role?: string) => {
  const row = snapshot.text.split('\n').find(line => line.startsWith('[') && line.includes(`"label":"${label}"`) && (!role || line.includes(`"captcha":"${role}"`)));
  assert.ok(row, `Missing ${label} ${role ?? ''}`); return row.match(/^\[([^\]]+)\]/)![1]!;
};
const canvasRef = (snapshot: Snapshot) => {
  const row = snapshot.text.split('\n').find(line => line.includes('"tag":"canvas"') && line.includes('"captcha":"region"'));
  assert.ok(row); return row.match(/^\[([^\]]+)\]/)![1]!;
};
try {
  await session.start();
  // Test-only access: the production MCP exposes no context, route or JavaScript tool.
  const context = (session as unknown as { context: BrowserContext }).context;
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url === DIRECTORY_URL) return route.fulfill({ contentType: 'text/html', body: '<h1>Owned directory fixture</h1>' });
    if (url === 'https://airline.example/tracking') return route.fulfill({ contentType: 'text/html', body: fixture });
    if (url === 'https://challenge.example/frame') return route.fulfill({ contentType: 'text/html', body: '<canvas id="captcha" width="140" height="50"></canvas><input aria-label="Captcha code">' });
    return route.abort();
  });
  await session.open(DIRECTORY_URL);
  let s = await session.open('https://airline.example/tracking');
  await assert.rejects(session.open('https://127.0.0.1/'), /public HTTPS/);
  s = await session.snapshot();
  await assert.rejects(session.fill(ref(s, 'AWB'), 'A7B9'), /Only the current AWB/);
  s = await session.snapshot();
  s = await session.fill(ref(s, 'AWB'), '112-90239332');
  let capture = await session.captchaInspect(canvasRef(s));
  assert.equal(capture.width, 160); assert.equal(capture.height, 60); assert.equal(capture.inputRefs.length, 1);
  await assert.rejects(session.captchaAct(capture.challengeId, { type: 'fill', ref: ref(s, '短信验证码'), value: '123456' }), /approved visual/);
  capture = await session.captchaInspect(canvasRef(s));
  s = await session.captchaAct(capture.challengeId, { type: 'fill', ref: capture.inputRefs[0]!, value: 'A7B9' });
  await assert.rejects(session.captchaAct(capture.challengeId, { type: 'click', point: { x: 10, y: 10 } }), /stale/);
  s = await session.click(ref(s, '查询')); assert.match(s.text, /CK123 PVG BNE ATD/);

  capture = await session.captchaInspect(canvasRef(s));
  await context.pages()[0]!.locator('#refresh').click(); // Change challenge outside model's observation.
  await assert.rejects(session.captchaAct(capture.challengeId, { type: 'fill', ref: capture.inputRefs[0]!, value: 'A7B9' }), /image changed/);
  s = await session.snapshot(); capture = await session.captchaInspect(canvasRef(s));
  await session.snapshot();
  await assert.rejects(session.captchaAct(capture.challengeId, { type: 'fill', ref: capture.inputRefs[0]!, value: 'C2D4' }), /stale/);
  s = await session.snapshot(); capture = await session.captchaInspect(canvasRef(s));
  s = await session.captchaAct(capture.challengeId, { type: 'fill', ref: capture.inputRefs[0]!, value: 'C2D4' });
  s = await session.click(ref(s, '查询')); assert.match(s.text, /CK123 PVG BNE ATD/);

  // The empty-label outer div is the bounded slider puzzle widget.
  const widget = () => { const row = s.text.split('\n').find(l => l.includes('"tag":"div"') && l.includes('"captcha":"region"') && l.includes('"label":""')); assert.ok(row); return row.match(/^\[([^\]]+)\]/)![1]!; };
  capture = await session.captchaInspect(widget());
  await assert.rejects(session.captchaAct(capture.challengeId, { type: 'click', point: { x: 900, y: 10 } }), /inside/);
  capture = await session.captchaInspect(widget());
  s = await session.captchaAct(capture.challengeId, { type: 'click', point: { x: 240, y: 70 } }); assert.match(s.text, /image click passed/);
  capture = await session.captchaInspect(widget());
  s = await session.captchaAct(capture.challengeId, { type: 'drag', from: { x: 20, y: 70 }, to: { x: 240, y: 70 } });
  assert.match(s.text, /slider passed/);
  const frameCanvas = s.text.split('\n').filter(l => l.includes('"tag":"canvas"') && l.includes('"captcha":"region"')).at(-1)!;
  capture = await session.captchaInspect(frameCanvas.match(/^\[([^\]]+)\]/)![1]!);
  assert.equal(capture.width, 140); assert.equal(capture.inputRefs.length, 1);
  s = await session.captchaAct(capture.challengeId, { type: 'fill', ref: capture.inputRefs[0]!, value: 'AB12' });
  capture = await session.captchaInspect(canvasRef(s));
  await assert.rejects(session.captchaAct(capture.challengeId, { type: 'fill', ref: capture.inputRefs[0]!, value: 'C2D4' }), /budget exhausted/);
  const evidence = await readEvidence(root, key, jobId, 1);
  assert.ok(evidence.filter(e => e.kind === 'captcha' && e.screenshot).length >= 8);
  assert.ok(evidence.some(e => e.kind === 'page' && e.text.includes('CK123 PVG BNE ATD')));
  console.log('CAPTCHA browser fixtures passed: text, refreshed images, click, drag, iframe, stale tokens, input/coordinate guards, budget and signed evidence. No model or live airline was used.');
} finally { await session.close(); await rm(root, { recursive: true, force: true }); }
