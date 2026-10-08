import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readEvidence, signEvidence, validateShipment } from '../src/evidence.js';
import { emptyShipment } from '../src/domain.js';
import { evidence, fixture, mawb, verifiedFixture } from './helpers.js';

test('verified actual times produce summary while preserving source format', () => {
  const f = verifiedFixture(); const result = validateShipment(mawb, f.result, f.evidence);
  assert.equal(result.status, 'complete'); assert.equal(result.summary.atd.value, '01 Sep 2026 10:00');
  assert.equal(result.summary.ata.value, '01 Sep 2026 15:00');
});
test('explicit Chinese actual labels map to ATD/ATA without translating source quotes', () => {
  const f = verifiedFixture();
  const old = f.result.segments[0]!.actualDeparture!.quote;
  const quote = old.replace('ATD', '实际起飞').replace('ATA', '实际到达');
  f.page.text = f.page.text.replace(old, quote);
  f.result.segments[0]!.actualDeparture!.quote = quote;
  f.result.segments[0]!.actualArrival!.quote = quote;
  const result = validateShipment(mawb, f.result, f.evidence);
  assert.equal(result.summary.atd.value, '01 Sep 2026 10:00');
  assert.equal(result.summary.ata.value, '01 Sep 2026 15:00');
  assert.equal(result.segments[0]!.actualArrival!.quote, quote);
  for (const invalid of ['计划起飞 01 Sep 2026 10:00 预计到达 01 Sep 2026 15:00', '理货完成 01 Sep 2026 10:00 留场提货 01 Sep 2026 15:00']) {
    const invalidQuote = `EK123 HKG RUH ${invalid}`;
    f.page.text = `${mawb}\n${invalidQuote}`;
    f.result.segments[0]!.actualDeparture!.quote = invalidQuote;
    f.result.segments[0]!.actualArrival!.quote = invalidQuote;
    const rejected = validateShipment(mawb, f.result, f.evidence);
    assert.equal(rejected.summary.atd.value, null); assert.equal(rejected.summary.ata.value, null);
  }
});
test('fabricated quote, unvisited evidence, wrong shipment and wrong route cannot supply actual time', () => {
  for (const change of ['quote', 'id', 'mawb', 'route', 'time']) {
    const f = verifiedFixture(); const time = f.result.segments[0]!.actualArrival!;
    if (change === 'quote') time.quote = 'fabricated ATA 01 Sep 2026 15:00';
    if (change === 'id') time.evidenceId = randomUUID();
    if (change === 'mawb') f.page.text = f.page.text.replace(mawb, '176-87654321');
    if (change === 'route') f.result.segments[0]!.destination = 'JED';
    if (change === 'time') time.value = '01 Sep 2026 17:00';
    assert.equal(validateShipment(mawb, f.result, f.evidence).segments[0]!.actualArrival, null, change);
  }
});
test('estimated labels and failed directory prerequisite never yield a successful result', () => {
  const f = verifiedFixture();
  (f.result.segments[0]!.actualArrival as any).label = 'ETA';
  assert.equal(validateShipment(mawb, f.result, f.evidence).status, 'blocked');
  const valid = verifiedFixture();
  assert.equal(validateShipment(mawb, valid.result, [valid.page]).status, 'blocked');
});
test('actual labels elsewhere in a quote cannot validate estimated or handling times', () => {
  for (const label of ['ETA', 'STA', 'Estimated Arrival', '预计到达', '计划抵达', 'RCF', 'DLV']) {
    const f = verifiedFixture(), segment = f.result.segments[0]!;
    const quote = `EK/0123 HKG RUH ATA pending ${label} 01 Sep 2026 15:00 237 pieces`;
    segment.flightNumber = 'EK/0123';
    segment.actualArrival!.quote = quote;
    f.page.text += `\n${quote}`;
    const r = validateShipment(mawb, f.result, f.evidence);
    assert.equal(r.summary.ata.value, null, label);
    assert.ok(r.issues.some(i => i.field === 'arrival' && i.code === 'unverified_time'), label);
  }
});
test('explicit conflict suppresses only affected leg and field', () => {
  const f = verifiedFixture();
  f.result.issues.push({ code: 'time_conflict', message: 'ATA and ARR differ', segmentId: 'leg-1', field: 'arrival', values: ['15:00', '15:04'] });
  const result = validateShipment(mawb, f.result, f.evidence);
  assert.equal(result.summary.ata.kind, 'conflict'); assert.equal(result.summary.atd.kind, 'value');
  assert.equal(result.segments[0]!.actualArrival, null);
});
test('known split arrival times remain visible as partial and road feeders never replace air arrival', () => {
  const f = verifiedFixture();
  const split = structuredClone(f.result.segments[0]!); split.id = 'leg-2'; split.group = 'part 2';
  const quote = 'EK456 HKG RUH ATD 02 Sep 2026 10:00 ATA 02 Sep 2026 15:00';
  f.page.text += `\n${quote}`; split.flightNumber = 'EK456';
  split.actualDeparture = { value: '02 Sep 2026 10:00', label: 'ATD', quote, evidenceId: f.page.id };
  split.actualArrival = { value: '02 Sep 2026 15:00', label: 'ATA', quote, evidenceId: f.page.id };
  f.result.segments.push(split);
  const partial = validateShipment(mawb, f.result, f.evidence);
  assert.equal(partial.summary.ata.value, '02 Sep 2026 15:00');
  assert.equal(partial.status, 'partial'); assert.match(partial.summary.ata.note, /仅部分记录/u);
  split.transportType = 'road';
  assert.equal(validateShipment(mawb, f.result, f.evidence).summary.ata.value, '01 Sep 2026 15:00');
});
test('no record is distinct from inaccessible website', () => {
  const f = verifiedFixture(), result = emptyShipment(mawb, 'no_results', 'No results'); result.status = 'not_found';
  assert.equal(validateShipment(mawb, result, f.evidence).status, 'blocked');
  f.page.text = `${mawb} No records found`;
  assert.equal(validateShipment(mawb, result, f.evidence).status, 'not_found');
});
test('evidence signatures reject altered content and cross-attempt replay', async () => {
  const f = fixture();
  try {
    const dir = join(f.config.dataDir, 'evidence'); await mkdir(dir);
    const e = evidence('original');
    await writeFile(join(dir, `${e.id}.json`), JSON.stringify({ evidence: e, signature: signEvidence(e, 'secret') }));
    assert.equal((await readEvidence(dir, 'secret', e.jobId, 1)).length, 1);
    const reordered = Object.fromEntries(Object.entries(e).reverse()) as unknown as typeof e;
    await writeFile(join(dir, `${e.id}.json`), JSON.stringify({ evidence: reordered, signature: signEvidence(reordered, 'secret') }));
    assert.equal((await readEvidence(dir, 'secret', e.jobId, 1)).length, 1, 'field order is not content');
    assert.equal((await readEvidence(dir, 'secret', e.jobId, 2)).length, 0);
    e.text = 'altered';
    await writeFile(join(dir, `${e.id}.json`), JSON.stringify({ evidence: e, signature: signEvidence(e, 'secret') }));
    assert.equal((await readEvidence(dir, 'secret', e.jobId, 1)).length, 0);
  } finally { f.cleanup(); }
});
