import type { ActualTime, Evidence, Segment, Shipment, SummaryTime } from './domain.js';
import { compact, eventPieceCount } from './time-context.js';
import { dateKey, extremeTime, parseSourceTime, timeKey } from './time-value.js';

type Field = 'departure' | 'arrival';
const uncertainCodes = new Set(['time_context_unverified', 'segment_identity_unclear', 'record_identity_unclear']);
export function hasUncertainTime(result: Shipment, segmentId: string, field: Field) {
  return result.issues.some(i => uncertainCodes.has(i.code) && (!i.segmentId || i.segmentId === segmentId)
    && (i.field === 'general' || i.field === field));
}

export function boundarySegments(result: Shipment, field: Field): Segment[] {
  const airport = field === 'departure' ? result.origin : result.destination;
  if (!airport) return [];
  const reachable = new Set([airport]);
  // Traverse only the ground connections before the first / after the last air
  // leg. Record order and the dates of intermediate flights are irrelevant.
  for (let changed = true; changed;) {
    changed = false;
    for (const s of result.segments.filter(s => s.transportType === 'road')) {
      const from = field === 'departure' ? s.origin : s.destination;
      const to = field === 'departure' ? s.destination : s.origin;
      if (from && to && reachable.has(from) && !reachable.has(to)) { reachable.add(to); changed = true; }
    }
  }
  return result.segments.filter(s => s.transportType === 'air'
    && reachable.has((field === 'departure' ? s.origin : s.destination) ?? ''));
}

interface EventGroup {
  segments: Segment[]; time: ActualTime | null; airport: string | null;
  conflict: boolean; ambiguous: boolean; uncertain: boolean; pieces: number | null; quantityMismatch: boolean;
}
export interface BoundaryResult {
  summary: SummaryTime; allTimesKnown: boolean; certain: boolean;
  fullCoverage: boolean; coveredPieces: number; groups: number;
  quantityUnknown: boolean; quantityConflict: boolean; endsAtDestination: boolean; singleWholeMovement: boolean;
}

function flightIdentity(s: Segment) {
  const flight = compact(s.flightNumber ?? '').replace(/[\s-]/gu, '').toUpperCase();
  if (!flight || !s.origin || !s.destination) return `unknown:${s.id}`;
  const event = s.actualDeparture ?? s.actualArrival;
  const date = event && parseSourceTime(event.value);
  const day = s.flightDate ? dateKey(s.flightDate) ?? compact(s.flightDate).toUpperCase()
    : date ? `${date.year}-${date.month}-${date.day}` : 'unknown-date';
  return `${s.origin}:${s.destination}:${flight}:${day}`;
}

function eventGroups(result: Shipment, segments: Segment[], field: Field, contexts: Map<ActualTime, string>, evidence: Map<string, Evidence>) {
  const key = field === 'departure' ? 'actualDeparture' : 'actualArrival';
  const movements = new Map<string, Segment[]>();
  const quotedEvents = new Map<string, string>();
  for (const s of segments) {
    const time = s[key], airport = field === 'departure' ? s.origin : s.destination;
    const quotedEvent = time && JSON.stringify([s.origin, s.destination, compact(s.flightNumber ?? '').replace(/[\s-]/gu, ''),
      timeKey(time.value, airport), compact(time.quote)]);
    const id = quotedEvent && quotedEvents.get(quotedEvent) || flightIdentity(s);
    if (quotedEvent) quotedEvents.set(quotedEvent, id);
    movements.set(id, [...(movements.get(id) ?? []), s]);
  }
  const groups: EventGroup[] = [];
  let overlappingGroups = false;
  for (const members of movements.values()) {
    const labels = [...new Set(members.map(s => compact(s.group ?? '')).filter(Boolean))];
    const batches = new Map<string, Segment[]>();
    for (const s of members) {
      const time = s[key], label = compact(s.group ?? ''), quote = compact(time?.quote ?? '');
      // Merely changing model group labels must not double-count the same row.
      const provenLabel = time && contexts.has(time) && label && quote.includes(label)
        && labels.every(other => other === label || !quote.includes(other));
      const batch = provenLabel ? label : '';
      batches.set(batch, [...(batches.get(batch) ?? []), s]);
    }
    if (batches.size > 1 && batches.has('')) overlappingGroups = true;
    for (const records of batches.values()) {
      const airport = field === 'departure' ? records[0]!.origin : records[0]!.destination;
      const times = records.flatMap(s => s[key] ? [s[key]!] : []);
      const different = new Set(times.map(t => timeKey(t.value, airport))).size > 1;
      const comparable = extremeTime(times.map(t => ({ value: t.value, airport })), false) !== undefined;
      const conflict = different && comparable, ambiguous = different && !comparable;
      const quantities = times.map(t => {
        const source = evidence.get(t.evidenceId), context = contexts.get(t);
        return source && context ? eventPieceCount(source.text, t, context) : undefined;
      }).filter((n): n is number => n !== undefined);
      const pieces = new Set(quantities).size === 1 && records.every(s => s.pieces === quantities[0]) ? quantities[0]! : null;
      const quantityMismatch = new Set(quantities).size > 1 || quantities.some(n => records.some(s => s.pieces !== null && s.pieces !== n));
      groups.push({ segments: records, time: times[0] ?? null, airport, conflict, ambiguous, pieces, quantityMismatch,
        uncertain: records.some(s => hasUncertainTime(result, s.id, field)) || times.some(t => !contexts.has(t)) });
    }
  }
  return { groups, overlappingGroups };
}

/** Summarize already-validated times; no source field or shipment batch is overwritten. */
export function aggregateBoundary(result: Shipment, field: Field, contexts: Map<ActualTime, string>, evidence: Map<string, Evidence>): BoundaryResult {
  const segments = boundarySegments(result, field);
  const { groups, overlappingGroups } = eventGroups(result, segments, field, contexts, evidence);
  const explicitConflict = result.issues.some(i => i.code === 'time_conflict' && i.field === field
    && (!i.segmentId || segments.some(s => s.id === i.segmentId)));
  for (const group of groups.filter(g => g.conflict)) {
    const key = field === 'departure' ? 'actualDeparture' : 'actualArrival';
    const values = [...new Set(group.segments.flatMap(s => s[key] ? [s[key]!.value] : []))];
    if (!result.issues.some(i => i.code === 'time_conflict' && i.segmentId === group.segments[0]!.id && i.field === field)) {
      result.issues.push({ code: 'time_conflict', segmentId: group.segments[0]!.id, field, values: values.slice(0, 10),
        message: '同一航班、日期和批次出现不同实际时间，无法确定首末时间；原始记录保留在航段明细。' });
    }
  }
  const conflict = explicitConflict || groups.some(g => g.conflict);
  const allTimesKnown = groups.length > 0 && groups.every(g => g.time !== null);
  const quantityUnknown = groups.some(g => !g.time || g.pieces === null || g.uncertain);
  const coveredPieces = groups.filter(g => g.time && !g.uncertain && !g.conflict).reduce((n, g) => n + (g.pieces ?? 0), 0);
  const quantityConflict = overlappingGroups || Boolean(result.pieces && coveredPieces > result.pieces)
    || groups.some(g => g.quantityMismatch || new Set(g.segments.map(s => s.pieces).filter(n => n !== null)).size > 1);
  const certain = !conflict && !quantityConflict && groups.every(g => !g.uncertain && !g.ambiguous);
  const fullCoverage = certain && allTimesKnown && !quantityUnknown && !quantityConflict
    && Boolean(result.pieces && coveredPieces === result.pieces);
  const data = { allTimesKnown, certain, fullCoverage, coveredPieces, groups: groups.length, quantityUnknown, quantityConflict,
    endsAtDestination: groups.length > 0 && groups.every(g => g.airport === result.destination),
    singleWholeMovement: groups.length === 1 && Boolean(result.pieces) && groups[0]!.segments.every(s => s.pieces === result.pieces) };
  const items = groups.flatMap(g => g.time ? [{ value: g.time.value, airport: g.airport }] : []);
  if (conflict) return { ...data, summary: { value: null, kind: 'conflict', note: '来源时间存在冲突，请查看航段详情' } };
  if (!items.length) return { ...data, summary: { value: null, kind: 'missing', note: '未取得可核实的实际时间' } };
  const selected = extremeTime(items, field === 'arrival');
  if (!selected || groups.some(g => g.ambiguous)) {
    return { ...data, certain: false, summary: { value: null, kind: 'multiple', note: '已取得多个实际时间，但日期格式或时区不足以确定先后；请查看批次明细' } };
  }
  const notes: string[] = [];
  if (!certain) notes.push('待核实：航段归属或件数未确认');
  if (quantityConflict) notes.push(`${field === 'departure' ? '出发' : '到达'}批次或件数存在重叠或不一致，待核实`);
  if (new Set(items.map(t => timeKey(t.value, t.airport))).size > 1) {
    notes.push(field === 'departure' ? '多批出发，取已知最早实际出发时间'
      : fullCoverage ? `分批到达，取末批实际到达时间（${coveredPieces}/${result.pieces} 件）` : '分批到达，取已知最晚实际到达时间');
  }
  if (!allTimesKnown || field === 'arrival' && !fullCoverage) notes.push(field === 'arrival' ? '仅部分记录，尚未确认全票到齐' : '仅部分记录，尚未确认所有出发批次');
  return { ...data, summary: { value: selected.value, kind: 'value', note: notes.join('；') } };
}
