import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { DIRECTORY_URL, emptyShipment, type Evidence, type Shipment } from '../src/domain.js';
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
