import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { validateShipment } from '../src/evidence.js';
import { compact } from '../src/time-context.js';
import { evidence, mawb, verifiedFixture } from './helpers.js';

// Fictional shipment; table structure matches an airline status/history page.
function tableFixture() {
  const f = verifiedFixture();
  Object.assign(f.result, { destination: 'BNE', pieces: 1, journeyComplete: false, completionEvidenceId: null, completionQuote: null });
  const first = f.result.segments[0]!;
  Object.assign(first, { destination: 'POM', pieces: 1, flightNumber: 'ZZ0019', flightDate: '01 SEP 2026' });
  const departure = 'ZZ0019, 01 SEP 2026, ATD 21:32, HKG-POM, STA - 02 SEP 2026 - 05:30';
  const arrival = 'ZZ0019, 01 SEP 2026, ATD 21:32, HKG-POM, ATA - 02 SEP 2026 - 04:20';
  const onward = 'ZZ0003, 02 SEP 2026, ATD 06:30, POM-BNE, STA - 02 SEP 2026 - 09:40';
  first.actualDeparture = { value: '01 SEP 2026 21:32', label: 'ATD', evidenceId: f.page.id, quote: departure };
  first.actualArrival = { value: '02 SEP 2026 04:20', label: 'ATA', evidenceId: f.page.id, quote: arrival };
  f.result.segments.push({ ...first, id: 'leg-2', origin: 'POM', destination: 'BNE', flightNumber: 'ZZ0003', flightDate: '02 SEP 2026',
    actualDeparture: { value: '02 SEP 2026 06:30', label: 'ATD', evidenceId: f.page.id, quote: onward }, actualArrival: null });
  f.page.text = `${mawb}\nStation\tStatus Date\tStatus\tFlight Details\tPieces\tWeight\n`
    + `HKG\t01 SEP 2026 21:32\tDeparted\t${departure}\t1\t1136.0 K\n`
    + `POM\t02 SEP 2026 04:20\tArrived\t${arrival}\t1\t1136.0 K\n`
    + `POM\t02 SEP 2026 06:30\tDeparted\t${onward}\t1\t1136.0 K`;
  return f;
}

test('recover actual event times from full rows when the model only quotes flight details', () => {
  const f = tableFixture(), original = structuredClone(f.result);
  const result = validateShipment(mawb, f.result, f.evidence);
  assert.equal(result.summary.atd.value, '01 SEP 2026 21:32');
  assert.equal(result.summary.atd.note, '');
  assert.equal(result.summary.ata.value, null);
  assert.equal(result.status, 'partial'); assert.equal(result.journeyComplete, false);
  assert.equal(result.segments[0]!.actualArrival!.value, '02 SEP 2026 04:20');
  assert.equal(result.segments[1]!.actualDeparture!.value, '02 SEP 2026 06:30');
  assert.equal(result.issues.filter(i => i.code === 'time_evidence_recovered').length, 3);
  assert.ok(!result.issues.some(i => i.code === 'unverified_time'));
  for (const s of result.segments) for (const time of [s.actualDeparture, s.actualArrival]) {
    if (time) assert.ok(compact(f.page.text).includes(time.quote));
  }
  assert.deepEqual(f.result, original, 'validation must not mutate the model result');
  const { summary, sourceUrls, checkedAt, ...replay } = result;
  const revalidated = validateShipment(mawb, replay, f.evidence);
  assert.deepEqual(revalidated.segments, result.segments);
  assert.deepEqual(revalidated.issues, result.issues);
});

test('repair reordered quotes, source date formatting, actual-label aliases and earlier unexpanded snapshots', () => {
  for (const change of ['reordered', 'format', 'label', 'snapshot']) {
    const f = tableFixture(), time = f.result.segments[0]!.actualDeparture!;
    if (change === 'reordered') time.quote = 'ATD 01 SEP 2026 21:32 ZZ0019 HKG-POM';
    if (change === 'format') time.value = '2026-09-01 21:32';
    if (change === 'label') time.label = 'DEP';
    if (change === 'snapshot') {
      const summary = evidence(`${mawb}\nHKG BNE 1 piece`, f.page.url, 2);
      f.page.sequence = 3; f.evidence.splice(1, 0, summary); time.evidenceId = summary.id;
    }
    const result = validateShipment(mawb, f.result, f.evidence);
    const recovered = result.segments[0]!.actualDeparture!;
    assert.equal(result.summary.atd.value, '01 SEP 2026 21:32', change);
    assert.equal(recovered.evidenceId, f.page.id, change);
    assert.equal(recovered.label, 'ATD', change);
    assert.ok(recovered.quote.includes('Departed'), change);
  }
});

test('recovery excludes planned, handling, contradictory and unscoped event records', () => {
  for (const change of ['wrong-shipment', 'other-shipment-row', 'form-only', 'flight', 'reverse-route', 'flight-date',
    'pieces', 'planned-status', 'planned-label', 'handling', 'conflict', 'wrong-value', 'wrong-marker', 'unknown-evidence',
    'incomplete-header', 'wrong-station', 'split-without-group', 'wrong-group', 'missing-flight-date', 'navigation', 'wrong-host']) {
    const f = tableFixture(), segment = f.result.segments[0]!, time = segment.actualDeparture!;
    if (change === 'wrong-shipment') f.page.text = f.page.text.replace(mawb, '176-87654321');
    if (change === 'other-shipment-row') f.page.text = f.page.text.replace('Station\t', '176-87654321\nStation\t');
    if (change === 'form-only') f.page.text = f.page.text.replace(mawb, '176-87654321') + `\nINTERACTIVE ELEMENTS (current input values included): ${mawb}`;
    if (change === 'flight') f.page.text = f.page.text.replaceAll('ZZ0019', 'ZZ0020');
    if (change === 'reverse-route') f.page.text = f.page.text.replaceAll('HKG-POM', 'POM-HKG');
    if (change === 'flight-date') segment.flightDate = '31 AUG 2026';
    if (change === 'pieces') f.page.text = f.page.text.replaceAll('\t1\t', '\t2\t');
    if (change === 'planned-status') f.page.text = f.page.text.replace('\tDeparted\t', '\tManifested\t');
    if (change === 'planned-label') f.page.text = f.page.text.replaceAll('ATD 21:32', 'STD 21:32');
    if (change === 'handling') f.page.text = f.page.text.replace('\tDeparted\t', '\tReceived from Shipper\t');
    if (change === 'conflict') f.page.text += '\n' + f.page.text.split('\n')[2]!.replaceAll('21:32', '21:35');
    if (change === 'wrong-value') time.value = '01 SEP 2026 21:31';
    if (change === 'wrong-marker') f.page.text = f.page.text.replaceAll('ATD 21:32', 'ATD 21:35');
    if (change === 'unknown-evidence') time.evidenceId = randomUUID();
    if (change === 'incomplete-header') f.page.text = f.page.text.replace('\tStatus Date\t', '\tUnknown\t');
    if (change === 'wrong-station') f.page.text = f.page.text.replace('\nHKG\t', '\nPOM\t');
    if (change === 'split-without-group') f.result.pieces = 2;
    if (change === 'wrong-group') segment.group = 'unproven batch';
    if (change === 'missing-flight-date') segment.flightDate = null;
    if (change === 'navigation') f.page.kind = 'navigation_attempt';
    if (change === 'wrong-host') {
      const summary = evidence(`${mawb}\nHKG BNE 1 piece`, f.page.url);
      time.evidenceId = summary.id; f.evidence.splice(1, 0, summary);
      f.page.url = 'https://another-airline.example/tracking';
    }
    const result = validateShipment(mawb, f.result, f.evidence);
    assert.equal(result.summary.atd.value, null, change);
    assert.ok(result.issues.some(i => i.code === 'unverified_time' && i.segmentId === segment.id && i.field === 'departure'), change);
  }
});

test('arrival recovery cannot promote a receiving event or planned arrival to an actual arrival', () => {
  for (const change of ['receiving', 'planned-time', 'wrong-date']) {
    const f = tableFixture(), segment = f.result.segments[0]!;
    if (change === 'receiving') f.page.text = f.page.text.replace('\tArrived\t', '\tReceived from Flight\t');
    if (change === 'planned-time') segment.actualArrival!.value = '02 SEP 2026 05:30';
    if (change === 'wrong-date') f.page.text = f.page.text.replace('ATA - 02 SEP 2026 - 04:20', 'ATA - 03 SEP 2026 - 04:20');
    assert.equal(validateShipment(mawb, f.result, f.evidence).segments[0]!.actualArrival, null, change);
  }
});

test('recovery respects shipment frames and deduplicates identical snapshots', () => {
  const f = tableFixture();
  f.page.text = `[Frame 0]\n${f.page.text}\n[Frame 1]\n176-87654321\nStation\tStatus Date\tStatus\tFlight Details\tPieces\tWeight\n`
    + f.page.text.split('\n')[2]!.replaceAll('21:32', '21:35');
  const repeated = { ...f.page, id: randomUUID(), sequence: 3 };
  f.evidence.push(repeated);
  const result = validateShipment(mawb, f.result, f.evidence);
  assert.equal(result.summary.atd.value, '01 SEP 2026 21:32');
  assert.equal(result.segments[0]!.actualDeparture!.evidenceId, repeated.id);
});

test('existing valid quotes and model-null times keep their existing behavior', () => {
  const f = tableFixture();
  f.result.segments[0]!.actualDeparture!.quote = compact(f.page.text.split('\n')[2]!);
  f.result.segments[0]!.actualArrival = null;
  const result = validateShipment(mawb, f.result, f.evidence);
  assert.equal(result.summary.atd.value, '01 SEP 2026 21:32');
  assert.equal(result.segments[0]!.actualArrival, null);
  assert.ok(!result.issues.some(i => i.code === 'time_evidence_recovered' && i.segmentId === 'leg-1'));
});

test('a split batch must match an explicit batch column, not a number elsewhere in the row', () => {
  for (const hasBatchColumn of [false, true]) {
    const f = tableFixture(), segment = f.result.segments[0]!;
    f.result.pieces = 2; segment.group = '1';
    if (hasBatchColumn) {
      f.page.text = f.page.text.replace('\tPieces\t', '\tBatch\tPieces\t')
        .replaceAll('\t1\t1136.0 K', '\t1\t1\t1136.0 K');
    }
    const result = validateShipment(mawb, f.result, f.evidence);
    assert.equal(result.summary.atd.value, hasBatchColumn ? '01 SEP 2026 21:32' : null);
  }
});
