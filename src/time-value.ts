import { compact } from './time-context.js';

const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const monthNames = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const monthNumber = (value: string) => value === 'SEPT' ? 9 : months.includes(value) ? months.indexOf(value) + 1 : monthNames.indexOf(value) + 1;
export interface CalendarDate { year: number; month: number; day: number }
export interface ParsedTime extends CalendarDate { wall: number; offset: number | null }

// Recognize explicit source dates, never Date.parse's locale-dependent guesses.
// Airline two-digit years use the fixed 1970–2069 window; missing years stay unknown.
export function parseSourceDate(raw: string): CalendarDate | undefined {
  const value = compact(raw).toUpperCase().replace(/年|月/g, '-').replace(/日/g, '').replace(/,/g, ' ').trim();
  let year: number, month: number, day: number;
  let match: RegExpMatchArray | null;
  if ((match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) {
    year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
  } else if ((match = value.match(/^(\d{1,2})[\s-]*([A-Z]+)[\s-]*(\d{4}|\d{2})$/))) {
    day = Number(match[1]); month = monthNumber(match[2]!); year = Number(match[3]);
    if (match[3]!.length === 2) year += year < 70 ? 2000 : 1900;
  } else if ((match = value.match(/^([A-Z]+)\s+(\d{1,2})\s+(\d{4})$/))) {
    month = monthNumber(match[1]!); day = Number(match[2]); year = Number(match[3]);
  } else if ((match = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))) {
    const first = Number(match[1]), second = Number(match[2]); year = Number(match[3]);
    if (first > 12 && second <= 12) { day = first; month = second; }
    else if (second > 12 && first <= 12 || first === second) { month = first; day = second; }
    else return; // 08/09/2026 has two possible meanings.
  } else return;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return;
  return { year, month, day };
}

export function dateKey(raw: string): string | undefined {
  const date = parseSourceDate(raw);
  return date && `${date.year}-${date.month}-${date.day}`;
}

export function parseSourceTime(raw: string): ParsedTime | undefined {
  let value = compact(raw).toUpperCase();
  let offset: number | null = null;
  const zone = value.match(/\s*(Z|UTC|GMT|(?:UTC|GMT)?([+-])(\d{2}):?(\d{2}))$/);
  if (zone) {
    if (zone[2]) {
      const hours = Number(zone[3]), minutes = Number(zone[4]);
      if (hours > 14 || minutes > 59 || hours === 14 && minutes !== 0) return;
      offset = (hours * 60 + minutes) * (zone[2] === '-' ? -1 : 1);
    } else offset = 0;
    value = value.slice(0, zone.index).trim();
  }
  const clocks = [...value.matchAll(/(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*(AM|PM)?(?![\dA-Z])/g)];
  if (clocks.length !== 1) return;
  const clock = clocks[0]!;
  let hour = Number(clock[1]);
  const minute = Number(clock[2]), second = Number(clock[3] ?? 0), millis = Number((clock[4] ?? '').padEnd(3, '0'));
  if (minute > 59 || second > 59 || hour > 23) return;
  if (clock[5]) {
    if (hour < 1 || hour > 12) return;
    hour = hour % 12 + (clock[5] === 'PM' ? 12 : 0);
  }
  const dateText = `${value.slice(0, clock.index)} ${value.slice(clock.index + clock[0].length)}`
    .replace(/[T,\s-]+$/g, '').replace(/^[,\s-]+/g, '').trim();
  const date = parseSourceDate(dateText);
  if (!date) return;
  return { ...date, wall: Date.UTC(date.year, date.month - 1, date.day, hour, minute, second, millis), offset };
}

export function timeKey(raw: string, airport: string | null): string {
  const time = parseSourceTime(raw);
  if (!time) return `raw:${airport}:${compact(raw).toUpperCase()}`;
  return time.offset === null ? `local:${airport}:${time.wall}` : `utc:${time.wall - time.offset * 60_000}`;
}

// Values remain untouched for display. Only compare local clocks at the same
// airport, or timestamps whose explicit offsets establish a common time basis.
export function extremeTime<T extends { value: string; airport: string | null }>(items: T[], latest: boolean): T | undefined {
  if (!items.length) return;
  if (new Set(items.map(t => timeKey(t.value, t.airport))).size === 1) return items[0];
  const parsed = items.map(t => parseSourceTime(t.value));
  if (parsed.some(t => !t)) return;
  const times = parsed as ParsedTime[];
  const absolute = times.every(t => t.offset !== null);
  if (!absolute && !(times.every(t => t.offset === null) && items[0]!.airport
    && items.every(t => t.airport === items[0]!.airport))) return;
  const values = times.map(t => t.wall - (absolute ? t.offset! * 60_000 : 0));
  const target = latest ? Math.max(...values) : Math.min(...values);
  return items[values.indexOf(target)];
}
