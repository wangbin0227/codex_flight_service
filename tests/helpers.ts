import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { DIRECTORY_URL, emptyShipment, type Evidence, type Shipment, type Segment } from '../src/domain.js';
export const key = 'unit-test-key-not-a-real-secret-123456789';
export const mawb = '176-12345678';
export function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'flight-test-'));
  const config = readConfig({ DATA_DIR: dataDir, SERVICE_API_KEYS: JSON.stringify({ test: key }), CODEX_API_KEY: 'not-a-real-model-key' });
  return { config, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}
export function evidence(text: string, url = 'https://www.skycargo.com/tracking', sequence = 2): Evidence {
  return { id: randomUUID(), jobId: randomUUID(), attempt: 1, url, capturedAt: new Date().toISOString(), text,
    sha256: createHash('sha256').update(text).digest('hex'), screenshot: false, sequence, kind: 'page' };
}
export function verifiedFixture() {
  const quote = 'EK123 HKG RUH ATD 01 Sep 2026 10:00 ATA 01 Sep 2026 15:00 237 pieces';
  const page = evidence(`${mawb}\n${quote}\nShipment is Delivered`);
  const directory = evidence('Air cargo tracking', DIRECTORY_URL, 1);
  const result: Shipment = { ...emptyShipment(mawb, '', ''), status: 'complete', carrier: 'Fixture Airline', origin: 'HKG', destination: 'RUH',
    pieces: 237, journeyComplete: true, completionEvidenceId: page.id, completionQuote: 'Shipment is Delivered', issues: [], evidenceIds: [page.id],
    segments: [{ id: 'leg-1', transportType: 'air', group: null, origin: 'HKG', destination: 'RUH', flightNumber: 'EK123', flightDate: '01 Sep 2026', pieces: 237,
      actualDeparture: { value: '01 Sep 2026 10:00', label: 'ATD', evidenceId: page.id, quote },
      actualArrival: { value: '01 Sep 2026 15:00', label: 'ATA', evidenceId: page.id, quote } }] };
  return { result, evidence: [directory, page], page };
}

export function conflictingDepartureFixture() {
  const f = verifiedFixture(), segment = f.result.segments[0]!;
  const later = '03 Sep 2026 09:15';
  f.page.text += `\nEK123 HKG RUH DEP ${later} 237 pieces`;
  f.result.issues.push({ code: 'time_conflict', segmentId: segment.id, field: 'departure',
    message: 'Candidate departure matches the flight date and arrival record; another DEP occurs two days later. The source gives no timezone, and the conflict is unresolved.',
    values: [later, segment.actualDeparture!.value] });
  return f;
}

// Fictional AWB with a tabular airline history: one first leg and two final batches.
export function splitShipmentFixture(total = 45, batchOne = 44, batchTwo = 1) {
  const f = verifiedFixture();
  Object.assign(f.result, { origin: 'HKG', destination: 'BOG', pieces: total, journeyComplete: false,
    completionEvidenceId: null, completionQuote: null, issues: [] });
  f.page.text = `${mawb}\nOrigin\tDestination\tTotal Pieces\tTotal Weight\nHKG\tBOG\t${total}\t864.0\n`
    + 'Station\tULD Info\tStatus\tEvent Time*\tDescription\tPieces\tWeight(kg)';
  const leg = (id: string, origin: string, destination: string, flight: string, flightDate: string,
    pieces: number, departure: string, arrival: string): Segment => {
    const description = `${flight}/${flightDate} ${origin}-${destination}`;
    const dep = `(DEP) Departed Flight ${departure} ${description} ${pieces} 864.0`;
    const arr = `(ARR) ${arrival} ${description} ${pieces} 864.0`;
    f.page.text += `\n${origin}\t\t(DEP) Departed Flight\t${departure}\t${description}\t${pieces}\t864.0`
      + `\n${destination}\t \t(ARR)\t${arrival}\t${description}\t${pieces}\t864.0`;
    return { id, origin, destination, transportType: 'air', group: null, flightNumber: flight, flightDate, pieces,
      actualDeparture: { value: departure, label: 'DEP', evidenceId: f.page.id, quote: dep },
      actualArrival: { value: arrival, label: 'ARR', evidenceId: f.page.id, quote: arr } };
  };
  f.result.segments = [
    leg('first', 'HKG', 'MIA', '5Y8030', '26AUG26', total, '26AUG26 01:00', '26AUG26 19:54'),
    leg('batch-one', 'MIA', 'BOG', '5Y073', '27AUG26', batchOne, '27AUG26 03:25', '29AUG26 06:57'),
    leg('batch-two', 'MIA', 'BOG', '5Y5577', '29AUG26', batchTwo, '29AUG26 09:39', '29AUG26 12:06'),
  ];
  return f;
}
