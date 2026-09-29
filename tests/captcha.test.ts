import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaptchaBudget, assertCaptchaText, assertPoint, captchaRole, type ElementInfo } from '../src/browser/captcha.js';
import { readConfig } from '../src/config.js';
import { validateShipment } from '../src/evidence.js';
import { mawb, verifiedFixture } from './helpers.js';

const field: ElementInfo = { tag: 'input', type: 'text', label: '验证码', identity: 'code-verify', context: 'verify-row', autocomplete: 'off' };
test('visual verification discovery excludes login and OTP fields', () => {
  assert.equal(captchaRole(field), 'input');
  assert.equal(captchaRole({ ...field, tag: 'img', identity: 'img-verify' }), 'region');
  for (const change of [{ type: 'password' }, { autocomplete: 'one-time-code' }, { label: '短信验证码' },
    { identity: 'sms-captcha' }, { context: 'password' }, { label: 'Email verification' }]) {
    assert.equal(captchaRole({ ...field, ...change }), undefined);
  }
  assert.equal(captchaRole({ ...field, label: 'AWB', identity: 'waybill', context: '' }), undefined);
});
test('CAPTCHA text, coordinate and per-attempt budgets fail closed', () => {
  for (const answer of ['A7b9', '12', '-5', '山水']) assert.doesNotThrow(() => assertCaptchaText(answer));
  for (const answer of ['', '<script>', 'hello world', 'x'.repeat(17), 'https://a.com']) assert.throws(() => assertCaptchaText(answer));
  assert.doesNotThrow(() => assertPoint({ x: 0, y: 79 }, 120, 80));
  for (const p of [{ x: -1, y: 2 }, { x: 120, y: 0 }, { x: 2, y: 80 }, { x: NaN, y: 0 }, { x: Infinity, y: 0 }]) assert.throws(() => assertPoint(p, 120, 80));
  const budget = new CaptchaBudget();
  for (let i = 0; i < 3; i++) budget.take('fill');
  assert.throws(() => budget.take('fill'), /budget exhausted/);
  budget.take('click');
});
test('challenge screenshots cannot prove actual times, completion or absence', () => {
  const f = verifiedFixture(); f.page.kind = 'captcha';
  let result = validateShipment(mawb, f.result, f.evidence);
  assert.equal(result.summary.atd.value, null);
  assert.equal(result.summary.ata.value, null);
  assert.equal(result.journeyComplete, false);
  f.result.segments = []; f.result.status = 'not_found'; f.page.text += '\nNo records found';
  result = validateShipment(mawb, f.result, f.evidence);
  assert.equal(result.status, 'blocked');
});
test('CAPTCHA resource hosts are distinct from navigation hosts and reject malformed hosts', () => {
  const config = readConfig({ BROWSER_RESOURCE_HOSTS: 'challenge.example.com, images.example.com' }, false);
  assert.deepEqual(config.resourceHosts, ['challenge.example.com', 'images.example.com']);
  assert.equal(config.allowedHosts.includes('challenge.example.com'), false);
  assert.throws(() => readConfig({ BROWSER_RESOURCE_HOSTS: 'https://example.com' }, false));
});
