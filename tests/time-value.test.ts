import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dateKey, extremeTime, parseSourceTime, timeKey } from '../src/time-value.js';

test('explicit airline, ISO, Chinese and AM/PM dates compare as the same local time', () => {
  const formats = ['26AUG26 08:56', '26 Aug 2026 08:56', '26-AUG-2026 08:56', '2026-08-26T08:56:00',
    '2026/08/26 08:56', '8:56 AM, Aug 26, 2026', '26 AUG 2026 - 08:56', '2026年8月26日 08:56',
    '8/26/2026 08:56', '26/8/2026 08:56', '8:56 AM, August 26, 2026'];
  for (const value of formats) {
    assert.equal(parseSourceTime(value)?.wall, Date.UTC(2026, 7, 26, 8, 56), value);
    assert.equal(timeKey(value, 'HKG'), timeKey(formats[0]!, 'HKG'), value);
  }
  assert.equal(dateKey('26AUG26'), dateKey('8/26/2026'));
  assert.equal(parseSourceTime('12:00 AM, Aug 26, 2026')?.wall, Date.UTC(2026, 7, 26));
  assert.equal(parseSourceTime('12:00 PM, Aug 26, 2026')?.wall, Date.UTC(2026, 7, 26, 12));
});

test('ordering respects calendar rollover and explicit offsets while preserving the selected source string', () => {
  const items = [{ value: '31AUG26 23:30', airport: 'BOG' }, { value: '01 Sep 2026 01:00', airport: 'BOG' }];
  assert.equal(extremeTime(items, false), items[0]); assert.equal(extremeTime(items, true), items[1]);
  assert.equal(timeKey('2026-08-26T08:56:00+08:00', 'HKG'), timeKey('2026-08-26T00:56:00Z', 'LHR'));
  const zoned = [{ value: '2026-08-26 08:00+08:00', airport: 'HKG' }, { value: '2026-08-26 01:00Z', airport: 'LHR' }];
  assert.equal(extremeTime(zoned, true), zoned[1]);
});

test('invalid, incomplete and ambiguous timestamps are not silently repaired', () => {
  for (const value of ['08/09/2026 12:00', '31 Feb 2026 12:00', '29 Feb 2025 12:00', '26 AUG 12:00',
    '2026-08-26 24:00', '2026-08-26 00:00 PM', '2026-08-26 12:61', '2026-08-26 12:00 CST',
    '2026-08-26 12:00+15:00', '08:56']) assert.equal(parseSourceTime(value), undefined, value);
  assert.ok(parseSourceTime('29 Feb 2024 12:00'));
  assert.equal(extremeTime([{ value: '26AUG26 12:00', airport: 'HKG' }, { value: '26AUG26 13:00', airport: 'LHR' }], true), undefined);
  assert.equal(extremeTime([{ value: '26AUG26 12:00', airport: 'HKG' }, { value: '26AUG26 13:00Z', airport: 'HKG' }], true), undefined);
});
