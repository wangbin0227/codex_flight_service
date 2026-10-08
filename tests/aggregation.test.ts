import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateShipment } from '../src/evidence.js';
import type { Segment } from '../src/domain.js';
import { mawb, splitShipmentFixture, verifiedFixture } from './helpers.js';

test('tabular 44 + 1 arrivals complete the shipment and select the last original ARR', () => {
  const f = splitShipmentFixture();
  const before = structuredClone(f.result.segments);
  const r = validateShipment(mawb, f.result, f.evidence);
  assert.equal(r.status, 'complete'); assert.equal(r.journeyComplete, true);
  assert.equal(r.summary.atd.value, '26AUG26 01:00');
  assert.equal(r.summary.ata.value, '29AUG26 12:06');
  assert.match(r.summary.ata.note, /分批到达.*45\/45/u);
  assert.deepEqual(r.segments, before);
  assert.deepEqual(f.result.segments, before, 'aggregation does not mutate model/source records');
});

test('duplicate snapshots, model labels and flight-date spelling cannot manufacture full arrival', () => {
  for (const variant of ['copy', 'label', 'flight-date']) {
    const f = splitShipmentFixture(45, 22, 1), duplicate = structuredClone(f.result.segments[1]!);
    duplicate.id = 'duplicate';
    if (variant === 'label') duplicate.group = 'another batch';
    if (variant === 'flight-date') duplicate.flightDate = '27AUG';
    f.result.segments.push(duplicate);
    const r = validateShipment(mawb, f.result, f.evidence);
    assert.equal(r.journeyComplete, false, variant); assert.equal(r.status, 'partial', variant);
    assert.equal(r.summary.ata.value, '29AUG26 12:06', variant);
    assert.match(r.summary.ata.note, /仅部分记录/u, variant);
  }
});

test('duplicate complete records do not prevent full arrival or erase batch details', () => {
  const f = splitShipmentFixture(), duplicate = structuredClone(f.result.segments[1]!);
  duplicate.id = 'duplicate'; duplicate.flightDate = '27 Aug 2026';
  f.result.segments.push(duplicate);
  const r = validateShipment(mawb, f.result, f.evidence);
  assert.equal(r.status, 'complete'); assert.equal(r.segments.length, 4);
  assert.equal(r.summary.ata.value, '29AUG26 12:06');
});

test('partial, missing and excessive arrival quantities keep known times without claiming full arrival', () => {
  for (const variant of ['missing-time', 'missing-batch', 'unknown-pieces', 'excess', 'quantity-mismatch']) {
    const f = variant === 'excess' ? splitShipmentFixture(45, 44, 2) : splitShipmentFixture();
    if (variant === 'missing-time') f.result.segments[2]!.actualArrival = null;
    if (variant === 'missing-batch') f.result.segments.pop();
    if (variant === 'unknown-pieces') f.result.segments[2]!.pieces = null;
    if (variant === 'quantity-mismatch') f.result.segments[1]!.pieces = 43;
    const r = validateShipment(mawb, f.result, f.evidence);
    assert.equal(r.status, 'partial', variant); assert.equal(r.journeyComplete, false, variant);
    assert.equal(r.summary.ata.value, ['missing-time', 'missing-batch'].includes(variant) ? '29AUG26 06:57' : '29AUG26 12:06', variant);
    assert.match(r.summary.ata.note, /仅部分记录/u, variant);
  }
});

test('handling and intermediate arrival rows do not fill a missing final batch', () => {
  const f = splitShipmentFixture();
  f.result.segments.pop();
  f.page.text += '\nBOG\t\t(RCF) Received Cargo from Flight\t29AUG26 06:57\t5Y073/27AUG26 MIA-BOG\t1\t19.0';
  const r = validateShipment(mawb, f.result, f.evidence);
  assert.equal(r.journeyComplete, false); assert.equal(r.status, 'partial');
  assert.equal(r.summary.ata.value, '29AUG26 06:57');
});

test('different first-leg batches select chronological earliest departure without requiring one shared time', () => {
  const f = verifiedFixture(), first = f.result.segments[0]!;
  f.result.pieces = 2; f.result.journeyComplete = false; f.result.completionEvidenceId = null; f.result.completionQuote = null;
  first.pieces = 1;
  const second = structuredClone(first); second.id = 'second'; second.flightNumber = 'EK456'; second.flightDate = '31 Aug 2026';
  first.actualDeparture!.value = '01 Sep 2026 01:00'; first.actualArrival!.value = '01 Sep 2026 15:00';
  second.actualDeparture!.value = '31 Aug 2026 23:00'; second.actualArrival!.value = '01 Sep 2026 13:00';
  f.page.text = mawb;
  for (const s of [first, second]) {
    const quote = `${s.flightNumber} HKG RUH ATD ${s.actualDeparture!.value} ATA ${s.actualArrival!.value} 1 pieces`;
    s.actualDeparture!.quote = s.actualArrival!.quote = quote; f.page.text += `\n${quote}`;
  }
  f.result.segments = [first, second];
  const r = validateShipment(mawb, f.result, f.evidence);
  assert.equal(r.status, 'complete');
  assert.equal(r.summary.atd.value, '31 Aug 2026 23:00'); assert.equal(r.summary.ata.value, '01 Sep 2026 15:00');
});

test('equivalent source formats deduplicate while conflicting times for the same movement remain visible', () => {
  for (const conflict of [false, true]) {
    const f = verifiedFixture(), s = f.result.segments[0]!, duplicate = structuredClone(s);
    duplicate.id = 'duplicate'; duplicate.flightDate = '2026-09-01';
    duplicate.actualArrival!.value = conflict ? '2026-09-01 15:04:00' : '2026-09-01 15:00:00';
    duplicate.actualArrival!.quote = `EK123 HKG RUH ATA ${duplicate.actualArrival!.value} 237 pieces`;
    f.page.text += `\n${duplicate.actualArrival!.quote}`; f.result.segments.push(duplicate);
    const r = validateShipment(mawb, f.result, f.evidence);
    assert.equal(r.summary.ata.kind, conflict ? 'conflict' : 'value');
    assert.equal(r.status, conflict ? 'partial' : 'complete');
    assert.ok(r.segments.every(s => s.actualArrival), 'both source records remain available');
    if (conflict) assert.ok(r.issues.some(i => i.code === 'time_conflict' && i.field === 'arrival'));
  }
});

test('a source-proven batch identifier permits distinct loads on one flight to add up', () => {
  const f = verifiedFixture(), first = f.result.segments[0]!, second = structuredClone(first);
  f.result.pieces = 45; f.result.journeyComplete = false; f.result.completionEvidenceId = null; f.result.completionQuote = null;
  first.pieces = 44; first.group = 'Batch A'; second.pieces = 1; second.group = 'Batch B'; second.id = 'batch-b';
  f.page.text = mawb;
  for (const s of [first, second]) {
    const quote = `${s.group} EK123 HKG RUH ATD ${s.actualDeparture!.value} ATA ${s.actualArrival!.value} ${s.pieces} pieces`;
    s.actualDeparture!.quote = s.actualArrival!.quote = quote; f.page.text += `\n${quote}`;
  }
  f.result.segments = [first, second];
  assert.equal(validateShipment(mawb, f.result, f.evidence).status, 'complete');
  first.group = second.group = null;
  const unassigned = validateShipment(mawb, f.result, f.evidence);
  assert.equal(unassigned.status, 'partial'); assert.equal(unassigned.journeyComplete, false);
  assert.ok(unassigned.summary.ata.value);
});

test('full delivery does not substitute the missing ATA of a known partial batch', () => {
  const f = splitShipmentFixture(); f.result.segments.pop();
  f.result.journeyComplete = true; f.result.completionEvidenceId = f.page.id; f.result.completionQuote = '45 pieces Delivered BOG';
  f.page.text += `\n${f.result.completionQuote}`;
  const r = validateShipment(mawb, f.result, f.evidence);
  assert.equal(r.journeyComplete, true); assert.equal(r.status, 'partial');
  assert.equal(r.summary.ata.value, '29AUG26 06:57'); assert.match(r.summary.ata.note, /仅部分记录/u);
});

test('first and last air legs are located through unordered road feeders without replacing them with road times', () => {
  for (const delivered of [false, true]) {
    const f = verifiedFixture(); f.result.origin = 'SZX'; f.result.destination = 'DMM';
    const road = (id: string, origin: string, destination: string): Segment => ({ id, origin, destination, transportType: 'road',
      flightNumber: null, flightDate: null, group: null, pieces: 237, actualDeparture: null, actualArrival: null });
    f.result.segments = [road('last-road', 'RUH', 'DMM'), ...f.result.segments, road('first-road', 'SZX', 'HKG'), road('loop', 'HKG', 'HKG')];
    f.result.journeyComplete = delivered;
    const r = validateShipment(mawb, f.result, f.evidence);
    assert.equal(r.summary.atd.value, '01 Sep 2026 10:00'); assert.equal(r.summary.ata.value, '01 Sep 2026 15:00');
    assert.equal(r.journeyComplete, delivered); assert.equal(r.status, delivered ? 'complete' : 'partial');
    if (!delivered) assert.match(r.summary.ata.note, /最终目的地.*待确认/u);
  }
});

test('ambiguous date formats preserve batch values without guessing the latest arrival', () => {
  const f = splitShipmentFixture(), last = f.result.segments[2]!;
  const before = last.actualArrival!.quote;
  last.actualArrival!.value = '08/09/2026 12:06';
  last.actualArrival!.quote = before.replace('29AUG26 12:06', last.actualArrival!.value);
  f.page.text = f.page.text.replace('29AUG26 12:06', last.actualArrival!.value);
  const r = validateShipment(mawb, f.result, f.evidence);
  assert.equal(r.status, 'partial'); assert.equal(r.summary.ata.kind, 'multiple');
  assert.equal(r.segments[2]!.actualArrival!.value, '08/09/2026 12:06');
});
