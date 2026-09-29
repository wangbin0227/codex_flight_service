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
test('explicit conflict suppresses only affected leg and field', () => {
  const f = verifiedFixture();
  f.result.issues.push({ code: 'time_conflict', message: 'ATA and ARR differ', segmentId: 'leg-1', field: 'arrival', values: ['15:00', '15:04'] });
  const result = validateShipment(mawb, f.result, f.evidence);
  assert.equal(result.summary.ata.kind, 'conflict'); assert.equal(result.summary.atd.kind, 'value');
  assert.equal(result.segments[0]!.actualArrival, null);
});
test('split shipments and road feeders never collapse into a single invented final time', () => {
  const f = verifiedFixture();
  const split = structuredClone(f.result.segments[0]!); split.id = 'leg-2'; split.group = 'part 2';
  const quote = 'EK456 HKG RUH ATD 02 Sep 2026 10:00 ATA 02 Sep 2026 15:00';
  f.page.text += `\n${quote}`; split.flightNumber = 'EK456';
  split.actualDeparture = { value: '02 Sep 2026 10:00', label: 'ATD', quote, evidenceId: f.page.id };
  split.actualArrival = { value: '02 Sep 2026 15:00', label: 'ATA', quote, evidenceId: f.page.id };
  f.result.segments.push(split);
  assert.equal(validateShipment(mawb, f.result, f.evidence).summary.ata.kind, 'multiple');
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
