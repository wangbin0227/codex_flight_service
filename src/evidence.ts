import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DIRECTORY_URL, emptyShipment, shipmentSchema, type ActualTime, type Evidence, type Shipment, type SummaryTime, type ValidatedShipment } from './domain.js';
import { compact, pieceCounts, shipmentScopes, timeContext } from './time-context.js';

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
const hasMawb = (text: string, mawb: string) => new RegExp(`(?<!\\d)${mawb.slice(0, 3)}[\\s-]*${mawb.slice(4)}(?!\\d)`).test(text);
function hasActualLabel(quote: string, time: ActualTime, field: 'departure' | 'arrival') {
  const sourceLabel = field === 'departure' ? /实际(?:起飞|出发)/u : /实际(?:到达|抵达)/u;
  if (!new RegExp(`\\b${time.label}\\b`, 'i').test(quote) && !sourceLabel.test(quote)) return false;
  const value = compact(time.value);
  if (!value) return false;
  const markers = [...quote.matchAll(/\b(?:ATD|DEP|ATA|ARR|Actual Departure|Actual Arrival|ETD|ETA|STD|STA|RCS|RCF|DLV|NFD|(?:Estimated|Expected|Scheduled) (?:Departure|Arrival))\b|(?:实际|预计|计划)(?:起飞|出发|到达|抵达)/giu)];
  // An actual label elsewhere in a broad quote cannot validate a value that
  // is explicitly preceded by an estimated, scheduled or handling event label.
  const nonActual = /^(?:ETD|ETA|STD|STA|RCS|RCF|DLV|NFD|Estimated |Expected |Scheduled |预计|计划)/iu;
  for (let at = quote.indexOf(value); at >= 0; at = quote.indexOf(value, at + value.length)) {
    const preceding = markers.findLast(m => m.index < at);
    if (!preceding || !nonActual.test(preceding[0])) return true;
  }
  return false;
}
function isDirectory(url: string) { const u = new URL(url); return u.hostname.replace(/^www\./, '') === 'track-trace.com'; }
function boundarySegments(result: Shipment, field: 'departure' | 'arrival') {
  const airport = field === 'departure' ? result.origin : result.destination;
  return result.segments.filter(s => s.transportType === 'air' && airport
    && (field === 'departure' ? s.origin === airport : s.destination === airport));
}
const uncertainTimeCodes = new Set(['time_context_unverified', 'segment_identity_unclear', 'record_identity_unclear']);
function hasUncertainTime(result: Shipment, segmentId: string, field: 'departure' | 'arrival') {
  return result.issues.some(i => uncertainTimeCodes.has(i.code) && (!i.segmentId || i.segmentId === segmentId)
    && (i.field === 'general' || i.field === field));
}
function summary(result: Shipment, field: 'departure' | 'arrival'): SummaryTime {
  const segments = boundarySegments(result, field);
  if (result.issues.some(i => i.code === 'time_conflict' && i.field === field
    && (!i.segmentId || segments.some(s => s.id === i.segmentId)))) {
    return { value: null, kind: 'conflict', note: '来源时间存在冲突，请查看航段详情' };
  }
  const times = segments.map(s => field === 'departure' ? s.actualDeparture : s.actualArrival);
  const values = [...new Set(times.filter(t => t !== null).map(t => t.value))];
  if (values.length > 1) return { value: null, kind: 'multiple', note: field === 'departure' ? '多次出发' : '分批到达' };
  if (!values.length) return { value: null, kind: 'missing', note: '未取得可核实的实际时间' };
  const notes: string[] = [];
  if (segments.some(s => (field === 'departure' ? s.actualDeparture : s.actualArrival) && hasUncertainTime(result, s.id, field))) {
    notes.push('待核实：航段归属或件数未确认');
  }
  if (times.includes(null) || (field === 'arrival' && !result.journeyComplete)) notes.push('仅部分记录');
  return { value: values[0]!, kind: 'value', note: notes.join('；') };
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
  const contexts = new Map<ActualTime, string>();
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
      const context = source ? timeContext(mawb, source.text, quote, segment, result.pieces) : undefined;
      const valid = context && context.status !== 'mismatch' && compact(time.value).length > 0 && quote.includes(compact(time.value))
        && (labels as readonly string[]).includes(time.label) && hasActualLabel(quote, time, field);
      if (!valid) {
        segment[key] = null;
        result.issues.push({ code: 'unverified_time', message: context?.status === 'mismatch'
          ? '引用记录与所填航班号或起终机场明确不符，已留空。'
          : '缺少本票页面中的连续时间原文或实际标签，已留空。',
          segmentId: segment.id, field, values: [time.value] });
      } else if (context.status === 'uncertain') {
        result.issues.push({ code: 'time_context_unverified', message: '已核实本票页面中的实际时间原文，但航班、航段或件数未能自动匹配；保留时间，待核实。',
          segmentId: segment.id, field, values: [time.value] });
      } else contexts.set(time, context.text);
      if (result.issues.some(i => i.code === 'time_conflict' && i.field === field && (!i.segmentId || i.segmentId === segment.id))) segment[key] = null;
    }
  }
  const completion = authoritative(result.completionEvidenceId);
  const completionQuote = compact(result.completionQuote ?? '');
  const deliveredPieces = pieceCounts(completionQuote);
  result.journeyComplete = Boolean(result.journeyComplete && completion && result.completionQuote
    && shipmentScopes(completion.text, mawb, completionQuote).length
    && !/\bpartial(?:ly)?\b|部分/iu.test(completionQuote)
    && deliveredPieces.every(n => n === result.pieces)
    && /\bdelivered\b|\bDLV\b|运输完成|已交付|已签收/i.test(result.completionQuote));
  // A confirmed final ARR for all pieces also establishes full arrival; never use DLV as the ATA itself.
  if (!result.journeyComplete && result.pieces && result.destination) {
    result.journeyComplete = result.segments.some(s => s.transportType === 'air' && s.destination === result.destination
      && s.pieces === result.pieces && s.actualArrival !== null
      && !hasUncertainTime(result, s.id, 'arrival')
      && pieceCounts(contexts.get(s.actualArrival) ?? '').includes(result.pieces!));
  }
  result.evidenceIds = [...new Set(result.evidenceIds.filter(id => byId.has(id)))];
  for (const s of result.segments) for (const t of [s.actualDeparture, s.actualArrival]) {
    if (t && !result.evidenceIds.includes(t.evidenceId)) result.evidenceIds.push(t.evidenceId);
  }
  const atd = summary(result, 'departure'), ata = summary(result, 'arrival');
  if (result.segments.length) {
    const first = boundarySegments(result, 'departure'), last = boundarySegments(result, 'arrival');
    const uncertain = first.some(s => hasUncertainTime(result, s.id, 'departure'))
      || last.some(s => hasUncertainTime(result, s.id, 'arrival'));
    result.status = result.journeyComplete && !uncertain && first.every(s => s.actualDeparture) && last.every(s => s.actualArrival)
      && atd.kind === 'value' && ata.kind === 'value' ? 'complete' : 'partial';
  } else if (result.status === 'not_found') {
    const proven = evidence.some(e => e.kind === 'page' && !isDirectory(e.url) && hasMawb(e.text, mawb)
      && /no (?:records?|results?|shipments?)|not found|暂无记录|未找到/i.test(e.text));
    if (!proven) { result.status = 'blocked'; result.issues.push({ code: 'unverified_absence', message: '未取得官网明确无记录的证据。', segmentId: null, field: 'general', values: [] }); }
  } else result.status = 'blocked';
  return { ...result, summary: { atd, ata }, sourceUrls: [...new Set(evidence.map(e => e.url))], checkedAt: new Date().toISOString() };
}
