import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DIRECTORY_URL, emptyShipment, shipmentSchema, type Evidence, type Shipment, type SummaryTime, type ValidatedShipment } from './domain.js';

export const evidenceSchema = z.object({
  id: z.string().uuid(), jobId: z.string().uuid(), attempt: z.number().int().positive(),
  url: z.string().url(), capturedAt: z.string().datetime(), text: z.string().max(500000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), screenshot: z.boolean(), sequence: z.number().int().positive(),
  kind: z.enum(['page', 'navigation_attempt', 'captcha']),
});
export function signEvidence(evidence: Evidence, key: string): string {
  // Schema parsing may reorder object keys. Sign a canonical representation.
  const canonical = Object.fromEntries(Object.entries(evidence).sort(([a], [b]) => a.localeCompare(b)));
  return createHmac('sha256', key).update(JSON.stringify(canonical)).digest('hex');
}
export async function readEvidence(dir: string, key: string, jobId: string, attempt: number): Promise<Evidence[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const result: Evidence[] = [];
  for (const name of names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).slice(0, 150)) {
    try {
      const raw = JSON.parse(await readFile(join(dir, name), 'utf8'));
      const evidence = evidenceSchema.parse(raw.evidence);
      const expected = Buffer.from(signEvidence(evidence, key));
      const actual = Buffer.from(String(raw.signature));
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) continue;
      if (evidence.jobId !== jobId || evidence.attempt !== attempt) continue;
      if (createHash('sha256').update(evidence.text).digest('hex') !== evidence.sha256) continue;
      result.push(evidence);
    } catch { /* Partial or invalid evidence is never accepted. */ }
  }
  return result.sort((a, b) => a.sequence - b.sequence);
}
const compact = (s: string) => s.normalize('NFKC').replace(/\s+/gu, ' ').trim();
const hasMawb = (text: string, mawb: string) => new RegExp(`(?<!\\d)${mawb.slice(0, 3)}[\\s-]*${mawb.slice(4)}(?!\\d)`).test(text);
function isDirectory(url: string) { const u = new URL(url); return u.hostname.replace(/^www\./, '') === 'track-trace.com'; }
function summary(result: Shipment, field: 'departure' | 'arrival'): SummaryTime {
  const airport = field === 'departure' ? result.origin : result.destination;
  const segments = result.segments.filter(s => s.transportType === 'air' && airport
    && (field === 'departure' ? s.origin === airport : s.destination === airport));
  if (result.issues.some(i => i.code === 'time_conflict' && i.field === field
    && (!i.segmentId || segments.some(s => s.id === i.segmentId)))) {
    return { value: null, kind: 'conflict', note: '来源时间存在冲突，请查看航段详情' };
  }
  const times = segments.map(s => field === 'departure' ? s.actualDeparture : s.actualArrival);
  const values = [...new Set(times.filter(t => t !== null).map(t => t.value))];
  if (values.length > 1) return { value: null, kind: 'multiple', note: field === 'departure' ? '多次出发' : '分批到达' };
  if (!values.length) return { value: null, kind: 'missing', note: '未取得可核实的实际时间' };
  return { value: values[0]!, kind: 'value', note: times.includes(null) || (field === 'arrival' && !result.journeyComplete) ? '仅部分记录' : '' };
}
export function validateShipment(mawb: string, raw: unknown, evidence: Evidence[]): ValidatedShipment {
  const parsed = shipmentSchema.safeParse(raw);
  let result = parsed.success && parsed.data.mawb === mawb ? structuredClone(parsed.data)
    : emptyShipment(mawb, 'invalid_model_result', '模型结果不符合格式或提单号不匹配。');
  const first = evidence[0];
  if (!first || first.url.replace(/\/$/, '') !== DIRECTORY_URL) {
    const issues = result.issues;
    result = emptyShipment(mawb, 'directory_not_visited', '未取得 track-trace 入口访问证据。');
    result.issues.push(...issues);
  }
  const byId = new Map(evidence.map(e => [e.id, e]));
  const authoritative = (id: string | null) => {
    const e = id ? byId.get(id) : undefined;
    return e && e.kind === 'page' && !isDirectory(e.url) && hasMawb(e.text, mawb) ? e : undefined;
  };
  const ids = new Set<string>();
  result.segments = result.segments.filter(s => {
    if (ids.has(s.id)) return false;
    ids.add(s.id); return true;
  });
  for (const segment of result.segments) {
    for (const [field, key, labels] of [
      ['departure', 'actualDeparture', ['ATD', 'DEP', 'Actual Departure']],
      ['arrival', 'actualArrival', ['ATA', 'ARR', 'Actual Arrival']],
    ] as const) {
      const time = segment[key];
      if (!time) continue;
      const source = authoritative(time.evidenceId);
      const quote = compact(time.quote);
      const sourceLabel = field === 'departure' ? /实际(?:起飞|出发)/u : /实际(?:到达|抵达)/u;
      const labelFound = new RegExp(`\\b${time.label}\\b`, 'i').test(quote) || sourceLabel.test(quote);
      const flightFound = Boolean(segment.flightNumber && quote.replace(/\s/g, '').includes(segment.flightNumber.replace(/\s/g, '')));
      const valid = source && compact(source.text).includes(quote) && quote.includes(compact(time.value))
        && (labels as readonly string[]).includes(time.label) && labelFound && flightFound
        && Boolean(segment.origin && quote.includes(segment.origin)) && Boolean(segment.destination && quote.includes(segment.destination));
      if (!valid) {
        segment[key] = null;
        result.issues.push({ code: 'unverified_time', message: '实际时间缺少同票、同航段、原始时间和实际标签的完整证据，已留空。',
          segmentId: segment.id, field, values: [time.value] });
      }
      if (result.issues.some(i => i.code === 'time_conflict' && i.field === field && (!i.segmentId || i.segmentId === segment.id))) segment[key] = null;
    }
  }
  const completion = authoritative(result.completionEvidenceId);
  result.journeyComplete = Boolean(result.journeyComplete && completion && result.completionQuote
    && compact(completion.text).includes(compact(result.completionQuote))
    && /\bdelivered\b|\bDLV\b|运输完成|已交付|已签收/i.test(result.completionQuote));
  // A confirmed final ARR for all pieces also establishes full arrival; never use DLV as the ATA itself.
  if (!result.journeyComplete && result.pieces && result.destination) {
    result.journeyComplete = result.segments.some(s => s.transportType === 'air' && s.destination === result.destination
      && s.pieces === result.pieces && s.actualArrival !== null
      && new RegExp(`\\b${result.pieces}\\b`).test(s.actualArrival.quote));
  }
  result.evidenceIds = [...new Set(result.evidenceIds.filter(id => byId.has(id)))];
  for (const s of result.segments) for (const t of [s.actualDeparture, s.actualArrival]) {
    if (t && !result.evidenceIds.includes(t.evidenceId)) result.evidenceIds.push(t.evidenceId);
  }
  const air = result.segments.filter(s => s.transportType === 'air');
  const atd = summary(result, 'departure'), ata = summary(result, 'arrival');
  if (result.segments.length) {
    result.status = result.journeyComplete && air.length > 0 && air.every(s => s.actualDeparture && s.actualArrival)
      && atd.kind === 'value' && ata.kind === 'value' ? 'complete' : 'partial';
  } else if (result.status === 'not_found') {
    const proven = evidence.some(e => e.kind === 'page' && !isDirectory(e.url) && hasMawb(e.text, mawb)
      && /no (?:records?|results?|shipments?)|not found|暂无记录|未找到/i.test(e.text));
    if (!proven) { result.status = 'blocked'; result.issues.push({ code: 'unverified_absence', message: '未取得官网明确无记录的证据。', segmentId: null, field: 'general', values: [] }); }
  } else result.status = 'blocked';
  return { ...result, summary: { atd, ata }, sourceUrls: [...new Set(evidence.map(e => e.url))], checkedAt: new Date().toISOString() };
}
