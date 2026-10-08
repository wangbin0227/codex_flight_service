import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaptchaBudget, assertCaptchaText, assertPoint, captchaActionSchema, captchaRole, type ElementInfo } from '../src/browser/captcha.js';
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
test('press-and-hold controls are recognized without turning login or ordinary buttons into challenges', () => {
  const button = { ...field, tag: 'button', type: 'button', identity: 'verify-target', context: '', label: 'Press & Hold •••' };
  for (const label of ['Press & Hold •••', 'Press and Hold', 'Hold to verify', '长按验证', '按住按钮验证']) {
    assert.equal(captchaRole({ ...button, label }), 'region', label);
    assert.equal(captchaRole({ ...button, tag: 'div', label }), 'region', label);
  }
  assert.equal(captchaRole({ ...button, label: 'Submit CAPTCHA' }), undefined);
  assert.equal(captchaRole({ ...button, label: 'Press & Hold', context: 'password' }), undefined);
});
test('hold duration and attempt budget are bounded independently of clicks and drags', () => {
  const hold = { type: 'hold', point: { x: 10, y: 10 }, durationMs: 6000 };
  for (const durationMs of [1000, 6000, 15000]) assert.ok(captchaActionSchema.safeParse({ ...hold, durationMs }).success);
  for (const durationMs of [undefined, 0, 999, 15001, Infinity, NaN, 1000.5]) assert.equal(captchaActionSchema.safeParse({ ...hold, durationMs }).success, false);
  const budget = new CaptchaBudget();
  for (let i = 0; i < 3; i++) budget.take('hold');
  assert.throws(() => budget.take('hold'), /budget exhausted/);
  assert.doesNotThrow(() => budget.take('click'));
  assert.doesNotThrow(() => budget.take('drag'));
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
