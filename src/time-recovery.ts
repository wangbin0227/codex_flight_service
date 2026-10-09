import type { ActualTime, Evidence, Segment } from './domain.js';
import { compact, timeContext, type TimeContext } from './time-context.js';
import { dateKey, parseSourceTime, timeKey, type ParsedTime } from './time-value.js';

type Field = 'departure' | 'arrival';
interface Recovery { time: ActualTime; context: TimeContext }
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sameTime = (a: ParsedTime, b: ParsedTime) => a.wall === b.wall && a.offset === b.offset;
const labelFor = (text: string, field: Field): ActualTime['label'] => {
  const value = text.replace(/[()]/gu, '').toUpperCase();
  if (value === 'DEP' || value === 'ARR') return value;
  if (value === 'ACTUAL DEPARTURE') return 'Actual Departure';
  if (value === 'ACTUAL ARRIVAL') return 'Actual Arrival';
  return field === 'departure' ? 'ATD' : 'ATA';
};

function actualLabel(status: string, details: string, event: ParsedTime, field: Field): ActualTime['label'] | undefined {
  const departure = field === 'departure';
  const statusPattern = departure
    ? /^(?:departed(?: flight)?|\(?DEP\)?(?: departed(?: flight)?)?|ATD|Actual Departure|实际起飞|实际出发)$/iu
    : /^(?:arrived|\(?ARR\)?(?: arrived)?|ATA|Actual Arrival|实际到达|实际抵达)$/iu;
  if (!statusPattern.test(status)) return;
  const pattern = departure ? /\b(ATD|DEP|Actual Departure)\b|实际(?:起飞|出发)/giu
    : /\b(ATA|ARR|Actual Arrival)\b|实际(?:到达|抵达)/giu;
  const labels = [...details.matchAll(pattern)];
  // A plain "Departed" status needs corroboration from the actual flight field.
  if (!labels.length) {
    if (/^(?:\(?DEP\)?|ATD|Actual Departure|实际起飞|实际出发)$/iu.test(status)) return departure ? labelFor(status, field) : undefined;
    if (/^(?:\(?ARR\)?|ATA|Actual Arrival|实际到达|实际抵达)$/iu.test(status)) return departure ? undefined : labelFor(status, field);
    return;
  }
  for (const label of labels) {
    const value = details.slice(label.index + label[0].length).split(/[,;]/u)[0]!.replace(/^[\s:：-]+/u, '').trim();
    const parsed = parseSourceTime(value);
    if (parsed) { if (!sameTime(parsed, event)) return; }
    else {
      const clock = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u);
      const date = new Date(event.wall);
      if (!clock || Number(clock[1]) !== date.getUTCHours() || Number(clock[2]) !== date.getUTCMinutes()
        || Number(clock[3] ?? 0) !== date.getUTCSeconds() || date.getUTCMilliseconds() !== 0) return;
    }
  }
  return labelFor(labels[0]![0], field);
}

/** Recover a submitted value only from a fully identified actual-event table row. */
export function recoverActualTime(mawb: string, value: string, segment: Segment, field: Field,
  totalPieces: number | null, evidence: Evidence[]): Recovery | undefined {
  const wanted = parseSourceTime(value), flightDate = segment.flightDate && dateKey(segment.flightDate);
  const flight = compact(segment.flightNumber ?? '').toUpperCase().replace(/[\s-]/gu, '')
    .match(/^([A-Z]{2,3}|[A-Z]\d|\d[A-Z])(\d{1,4}[A-Z]?)$/u);
  if (!wanted || !flight || !flightDate || !segment.origin || !segment.destination || !segment.pieces
    || (!segment.group && segment.pieces !== totalPieces)) return;
  const flightPattern = new RegExp(`\\b${escape(flight[1]!)}\\s*-?\\s*${escape(flight[2]!)}\\b`, 'iu');
  const routePattern = new RegExp(`\\b${segment.origin}\\s*(?:[-–—→/>]|to|\\s)\\s*${segment.destination}\\b`, 'iu');
  const station = field === 'departure' ? segment.origin : segment.destination;
  const records: Recovery[] = [];
  for (const source of evidence) {
    if (source.kind !== 'page' || new URL(source.url).hostname.replace(/^www\./u, '') === 'track-trace.com') continue;
    let columns: { station: number; time: number; status: number; details: number; pieces: number; group: number; length: number } | undefined;
    for (const line of source.text.split('INTERACTIVE ELEMENTS (current input values included):')[0]!.split('\n')) {
      if (/\[Frame \d+\]/u.test(line)) columns = undefined;
      const cells = line.split('\t').map(compact);
      const header = cells.map(c => c.replace(/\*/gu, '').trim());
      const status = header.findIndex(c => /^status$/iu.test(c));
      const pieces = header.findIndex(c => /^(?:pieces?|pcs|件数)$/iu.test(c));
      if (status >= 0 || pieces >= 0) {
        const station = header.findIndex(c => /^station$/iu.test(c));
        const time = header.findIndex(c => /^(?:status date|event time|event date(?:\/time)?|date(?:\/time)?|date time|timestamp)$/iu.test(c));
        const details = header.findIndex(c => /^(?:flight details|description)$/iu.test(c));
        const group = header.findIndex(c => /^(?:batch|group|批次|分批)$/iu.test(c));
        columns = [station, time, status, details, pieces].every(n => n >= 0)
          ? { station, time, status, details, pieces, group, length: cells.length } : undefined;
        continue;
      }
      if (!columns || cells.length !== columns.length || cells[columns.station] !== station
        || !/^\d+$/u.test(cells[columns.pieces]!) || Number(cells[columns.pieces]) !== segment.pieces) continue;
      const quote = compact(line), details = cells[columns.details]!;
      if (quote.length > 5000 || !routePattern.test(details)) continue;
      if (segment.group && (columns.group < 0 || cells[columns.group] !== compact(segment.group))) continue;
      const flightMatch = details.match(flightPattern);
      if (!flightMatch) continue;
      // The flight's own date distinguishes repeated flight numbers across days.
      const recordDate = details.slice(flightMatch.index! + flightMatch[0].length).replace(/^[\s,/]+/u, '')
        .match(/^(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[\s-]*[A-Z]+[\s-]*(?:\d{4}|\d{2}))(?!\d)/iu)?.[1];
      if (!recordDate || dateKey(recordDate) !== flightDate) continue;
      const eventValue = cells[columns.time]!, event = parseSourceTime(eventValue);
      if (!event) continue;
      const label = actualLabel(cells[columns.status]!, details, event, field);
      if (!label) continue;
      const context = timeContext(mawb, source.text, quote, segment, totalPieces);
      if (context?.status !== 'verified') continue;
      records.push({ time: { value: eventValue, label, evidenceId: source.id, quote }, context });
    }
  }
  // Repeated snapshots are fine; competing actual events must not be resolved by
  // whichever row happens to match the model's proposed value.
  if (new Set(records.map(r => timeKey(r.time.value, station))).size !== 1) return;
  return records.findLast(r => sameTime(parseSourceTime(r.time.value)!, wanted));
}
