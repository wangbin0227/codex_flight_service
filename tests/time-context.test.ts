import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateShipment } from '../src/evidence.js';
import { pieceCounts } from '../src/time-context.js';
import type { Segment } from '../src/domain.js';
import { mawb, verifiedFixture } from './helpers.js';

// Fictional records: shared route header and complementary shipment nodes across dates.
function contextFixture() {
  const f = verifiedFixture(), s = f.result.segments[0]!;
  f.result.pieces = s.pieces = 75;
  f.result.journeyComplete = false;
  f.result.completionEvidenceId = null; f.result.completionQuote = null;
  s.group = '第一批 / 第二批'; s.flightDate = '01 Sep 2026 / 02 Sep 2026';
  s.actualDeparture!.quote = '实际起飞 01 Sep 2026 10:00';
  s.actualArrival!.value = '02 Sep 2026 15:00';
  s.actualArrival!.quote = '实际到达 02 Sep 2026 15:00';
  f.page.text = `运单号 ${mawb}\n件数 75\n航段信息 HKG RUH
第一批 件数 75 航班号 EK123 航班日期 01 Sep 2026 实际起飞 01 Sep 2026 10:00 实际到达 ———
第二批 件数 75 航班号 EK123 航班日期 02 Sep 2026 实际起飞 ——— 实际到达 02 Sep 2026 15:00`;
  f.result.issues = [{ code: 'shipment_nodes_merged', field: 'general', segmentId: s.id,
    message: 'Complementary full-shipment nodes; flight instance not independently verified.', values: [s.group, s.flightDate] }];
  return f;
}

test('short actual-time quotes use an unambiguous shared shipment context across dates', () => {
  const f = contextFixture(), r = validateShipment(mawb, f.result, f.evidence);
  assert.equal(r.status, 'complete'); assert.equal(r.journeyComplete, true);
  assert.equal(r.summary.atd.value, '01 Sep 2026 10:00'); assert.equal(r.summary.ata.value, '02 Sep 2026 15:00');
  assert.equal(r.pieces, 75); assert.equal(r.segments[0]!.pieces, 75);
  assert.equal(r.segments[0]!.group, '第一批 / 第二批');
  assert.equal(r.segments[0]!.flightDate, '01 Sep 2026 / 02 Sep 2026');
  assert.equal(r.segments[0]!.actualArrival!.quote, '实际到达 02 Sep 2026 15:00');
  assert.ok(r.issues.some(i => i.code === 'shipment_nodes_merged'));
});

test('wrong shipments, fabricated quotes and unsupported times remain rejected', () => {
  for (const change of ['shipment', 'form', 'quote', 'value', 'label']) {
    const f = contextFixture();
    if (change === 'shipment') f.page.text = f.page.text.replace('第二批', '176-87654321 第二批');
    if (change === 'form') f.page.text = f.page.text.replace(mawb, '176-87654321') + `\nINTERACTIVE ELEMENTS (current input values included): ${mawb}`;
    if (change === 'quote') f.result.segments[0]!.actualArrival!.quote += ' HKG RUH';
    if (change === 'value') f.result.segments[0]!.actualArrival!.value = '02 Sep 2026 16:00';
    if (change === 'label') f.page.text = f.page.text.replace('实际到达 02 Sep 2026 15:00', '预计到达 02 Sep 2026 15:00');
    const r = validateShipment(mawb, f.result, f.evidence);
    assert.equal(r.summary.ata.value, null, change);
    assert.equal(r.status, 'partial', change);
    assert.ok(r.issues.some(i => i.code === 'unverified_time' && i.field === 'arrival'), change);
  }
});

test('ambiguous shared contexts preserve source times as pending instead of borrowing an identity', () => {
  for (const change of ['flight', 'route', 'split', 'frame']) {
    const f = contextFixture();
    if (change === 'flight') f.page.text = f.page.text.replace('第二批 件数 75 航班号 EK123', '第二批 件数 75 航班号 EK456');
    if (change === 'route') f.page.text = f.page.text.replace('第二批', 'HKG JED 第二批');
    if (change === 'split') f.page.text = f.page.text.replace('第一批 件数 75', '第一批 件数 25').replace('第二批 件数 75', '第二批 件数 50');
    if (change === 'frame') f.page.text = f.page.text.replace('航段信息 HKG RUH', '[Frame 1] 航段信息 HKG RUH [Frame 2]');
    const r = validateShipment(mawb, f.result, f.evidence);
    assert.equal(r.summary.ata.value, '02 Sep 2026 15:00', change);
    assert.match(r.summary.ata.note, /待核实/u, change);
    assert.equal(r.journeyComplete, false, change);
    assert.equal(r.status, 'partial', change);
    assert.ok(r.issues.some(i => i.code === 'time_context_unverified' && i.field === 'arrival'), change);
    assert.ok(!r.issues.some(i => i.code === 'unverified_time'), change);
  }
});

test('missing or unsupported flight formats keep raw actual times and field-specific warnings', () => {
  for (const flight of [null, 'EK/0123']) {
    const f = verifiedFixture(), segment = f.result.segments[0]!;
    const oldQuote = segment.actualDeparture!.quote;
    const quote = oldQuote.replace('EK123', flight ?? '');
    f.page.text = f.page.text.replace(oldQuote, quote);
    segment.flightNumber = flight;
    segment.actualDeparture!.quote = segment.actualArrival!.quote = quote;
    const r = validateShipment(mawb, f.result, f.evidence);
    assert.equal(r.status, 'partial');
    assert.equal(r.summary.atd.value, '01 Sep 2026 10:00');
    assert.equal(r.summary.ata.value, '01 Sep 2026 15:00');
    assert.match(r.summary.atd.note, /待核实/u);
    assert.match(r.summary.ata.note, /待核实/u);
    assert.equal(r.segments[0]!.actualArrival!.quote, quote);
    assert.equal(r.issues.filter(i => i.code === 'time_context_unverified').length, 2);
  }
});

test('quantity mismatch preserves actual times but cannot infer full arrival', () => {
  const f = verifiedFixture(), segment = f.result.segments[0]!;
  f.result.journeyComplete = false;
  f.result.completionEvidenceId = null; f.result.completionQuote = null;
  const oldQuote = segment.actualDeparture!.quote;
  const quote = oldQuote.replace('237 pieces', '100 pieces');
  f.page.text = f.page.text.replace(oldQuote, quote);
  segment.actualDeparture!.quote = segment.actualArrival!.quote = quote;
  const r = validateShipment(mawb, f.result, f.evidence);
  assert.equal(r.summary.atd.value, '01 Sep 2026 10:00');
  assert.equal(r.summary.ata.value, '01 Sep 2026 15:00');
  assert.equal(r.journeyComplete, false);
  assert.equal(r.status, 'partial');
  assert.match(r.summary.ata.note, /待核实.*仅部分记录/u);
});

test('self-contained quotes still work when the page contains several flights', () => {
  const f = verifiedFixture();
  f.page.text += '\nEK456 HKG JED ATA 03 Sep 2026 16:00 50 pieces';
  const r = validateShipment(mawb, f.result, f.evidence);
  assert.equal(r.summary.ata.value, '01 Sep 2026 15:00');
});

test('hyphenated flight numbers preserve actual times and source formatting', () => {
  for (const pageFlight of ['EK-0123', 'EK - 0123', 'EK0123', 'EK 0123', 'EK-0123D', '5X-0123', 'B7-0123']) {
    for (const modelFlight of [pageFlight, pageFlight.replace(/[\s-]/gu, '')]) {
      const f = verifiedFixture(), segment = f.result.segments[0]!;
      const quote = segment.actualDeparture!.quote.replace('EK123', pageFlight);
      f.page.text = f.page.text.replace(segment.actualDeparture!.quote, quote);
      segment.flightNumber = modelFlight;
      segment.actualDeparture!.quote = segment.actualArrival!.quote = quote;
      // Other routes force verification against the quoted record, not a shared header.
      f.page.text += '\nEK-0456 HKG JED ATA 02 Sep 2026 16:00 50 pieces';
      const r = validateShipment(mawb, f.result, f.evidence);
      assert.equal(r.status, 'complete', `${pageFlight} / ${modelFlight}`);
      assert.equal(r.summary.atd.value, '01 Sep 2026 10:00');
      assert.equal(r.summary.ata.value, '01 Sep 2026 15:00');
      assert.equal(r.segments[0]!.flightNumber, modelFlight);
      assert.equal(r.segments[0]!.actualArrival!.quote, quote);
    }
  }
});

test('flight separator normalization does not accept a different flight or suffix', () => {
  for (const otherFlight of ['EK-0456', 'EK-0123D', '5X-0123']) {
    const f = verifiedFixture(), segment = f.result.segments[0]!;
    const quote = segment.actualDeparture!.quote.replace('EK123', otherFlight);
    f.page.text = f.page.text.replace(segment.actualDeparture!.quote, quote);
    segment.flightNumber = 'EK-0123';
    segment.actualDeparture!.quote = segment.actualArrival!.quote = quote;
    const r = validateShipment(mawb, f.result, f.evidence);
    assert.equal(r.summary.atd.value, null, otherFlight);
    assert.equal(r.summary.ata.value, null, otherFlight);
  }
});

test('piece units bind to one quantity and do not reinterpret the following weight', () => {
  for (const text of ['237 Pieces 2847 K', '237 Pieces\n2847 K', '237 PCS 2847 KG',
    '237 pieces 2847.25 kg', 'Pieces: 237 Weight: 2847 K', 'Pieces 237', 'PCS: 237', '件数：237', '237件 重量2847公斤']) {
    assert.deepEqual(pieceCounts(text), [237], text);
  }
  assert.deepEqual(pieceCounts('21 Pieces 292.26 K'), [21]);
  assert.deepEqual(pieceCounts('237 Pieces 2847 K 100 Pieces 1200 K'), [237, 100]);
});

test('delivery quantity followed by a weight proves completion only for all pieces', () => {
  for (const delivered of [237, 100]) {
    const f = verifiedFixture();
    f.result.completionQuote = `DLV RUH Delivered to the Consignee ${delivered} Pieces 2847 K`;
    f.page.text += `\n${f.result.completionQuote}`;
    // The arrival quote has no quantity, so it cannot independently prove full arrival.
    const quote = f.result.segments[0]!.actualArrival!.quote.replace(' 237 pieces', '');
    f.page.text = f.page.text.replace(f.result.segments[0]!.actualArrival!.quote, quote);
    f.result.segments[0]!.actualDeparture!.quote = f.result.segments[0]!.actualArrival!.quote = quote;
    f.page.text += '\nEK456 HKG JED 50 pieces';
    const r = validateShipment(mawb, f.result, f.evidence);
    assert.equal(r.journeyComplete, delivered === 237);
    assert.equal(r.status, delivered === 237 ? 'complete' : 'partial');
    assert.equal(r.summary.ata.value, '01 Sep 2026 15:00');
  }
});

function journeyFixture() {
  const f = verifiedFixture();
  const first: Segment = { ...f.result.segments[0]!, destination: 'DXB', actualArrival: null };
  first.actualDeparture = { ...first.actualDeparture!, quote: 'EK123 HKG DXB ATD 01 Sep 2026 10:00 237 pieces' };
  const middle: Segment = { ...first, id: 'leg-2', origin: 'DXB', destination: 'DOH', flightNumber: 'EK456',
    actualDeparture: null, actualArrival: null };
  const last: Segment = { ...first, id: 'leg-3', origin: 'DOH', destination: 'RUH', flightNumber: 'EK789', actualDeparture: null,
    actualArrival: { value: '01 Sep 2026 15:00', label: 'ATA', evidenceId: f.page.id, quote: 'EK789 DOH RUH ATA 01 Sep 2026 15:00 237 pieces' } };
  f.result.segments = [first, middle, last];
  f.result.journeyComplete = false; f.result.completionEvidenceId = null; f.result.completionQuote = null;
  f.page.text = `${mawb}\n${first.actualDeparture.quote}\nEK456 DXB DOH\n${last.actualArrival!.quote}`;
  return f;
}

test('verified first departure and final full arrival suffice despite missing intermediate times', () => {
  const f = journeyFixture();
  f.result.issues.push({ code: 'time_conflict', field: 'arrival', segmentId: 'leg-2', message: 'Intermediate event conflict', values: ['12:00', '12:05'] });
  const r = validateShipment(mawb, f.result, f.evidence);
  assert.equal(r.status, 'complete'); assert.equal(r.journeyComplete, true);
  assert.equal(r.segments[1]!.actualArrival, null); assert.equal(r.issues.length, 1);
  assert.equal(r.summary.atd.value, '01 Sep 2026 10:00'); assert.equal(r.summary.ata.value, '01 Sep 2026 15:00');
});

test('missing, conflicting or unassigned boundary times and partial quantities remain partial', () => {
  for (const change of ['departure', 'arrival', 'conflict', 'identity', 'quantity', 'split']) {
    const f = journeyFixture(), first = f.result.segments[0]!, last = f.result.segments[2]!;
    if (change === 'departure') first.actualDeparture = null;
    if (change === 'arrival') last.actualArrival = null;
    if (change === 'conflict') f.result.issues.push({ code: 'time_conflict', field: 'arrival', segmentId: last.id, message: 'Final arrival conflict', values: ['15:00', '15:05'] });
    if (change === 'identity') f.result.issues.push({ code: 'segment_identity_unclear', field: 'general', segmentId: first.id, message: 'First record ownership unclear', values: [] });
    if (change === 'quantity') last.pieces = 100;
    if (change === 'split') f.result.segments.push({ ...first, id: 'split-first', flightNumber: 'EK987', pieces: 10, actualDeparture: null });
    assert.equal(validateShipment(mawb, f.result, f.evidence).status, 'partial', change);
  }
});

test('partial delivery or another shipment delivery cannot prove whole-shipment completion', () => {
  for (const change of ['quantity', 'partial', 'shipment']) {
    const f = journeyFixture(), last = f.result.segments[2]!;
    last.pieces = 100;
    last.actualArrival!.quote = last.actualArrival!.quote.replace('237 pieces', '100 pieces');
    f.page.text = f.page.text.replace('EK789 DOH RUH ATA 01 Sep 2026 15:00 237 pieces', last.actualArrival!.quote);
    f.result.journeyComplete = true; f.result.completionEvidenceId = f.page.id;
    f.result.completionQuote = change === 'quantity' ? '100 pieces Delivered' : change === 'partial' ? 'Partially delivered' : 'Shipment is Delivered';
    f.page.text += `\n${change === 'shipment' ? '176-87654321\n' : ''}${f.result.completionQuote}`;
    const r = validateShipment(mawb, f.result, f.evidence);
    assert.equal(r.summary.ata.value, '01 Sep 2026 15:00', change);
    assert.equal(r.journeyComplete, false, change); assert.equal(r.status, 'partial', change);
  }
});
