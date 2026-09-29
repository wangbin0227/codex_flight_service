import type { Segment } from './domain.js';

export const compact = (s: string) => s.normalize('NFKC').replace(/\s+/gu, ' ').trim();
const mawbPattern = /(?<!\d)(\d{3})[\s-]*(\d{8})(?!\d)/gu;
const nonAirportCodes = new Set(['AWB', 'ATD', 'ATA', 'DEP', 'ARR', 'ETD', 'ETA', 'STD', 'STA',
  'RCS', 'RCF', 'DLV', 'ULD', 'PCS', 'KGS', 'UTC', 'GMT', 'NIL', 'TBA', 'TBC', 'EST', 'ACT',
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']);
const flightPattern = /\b(?:[A-Z]{2,3}|[A-Z]\d|\d[A-Z])\s*\d{1,4}[A-Z]?\b/gu;

export function shipmentScopes(text: string, mawb: string, quote: string): string[] {
  // Form values and links are not shipment records. Keep frame and MAWB boundaries.
  const body = text.split('INTERACTIVE ELEMENTS (current input values included):')[0]!;
  const ids = [...compact(body).matchAll(mawbPattern)].map(m => `${m[1]}-${m[2]}`);
  const onlyThisShipment = ids.length > 0 && ids.every(id => id === mawb);
  const scopes: string[] = [];
  for (const frame of body.split(/\[Frame \d+\]/u)) {
    const value = compact(frame);
    if (!value.includes(quote)) continue;
    const matches = [...value.matchAll(mawbPattern)];
    if (onlyThisShipment || (matches.length && matches.every(m => `${m[1]}-${m[2]}` === mawb))) {
      scopes.push(value);
      continue;
    }
    for (const [index, match] of matches.entries()) {
      if (`${match[1]}-${match[2]}` !== mawb) continue;
      const nextOther = matches.slice(index + 1).find(m => `${m[1]}-${m[2]}` !== mawb);
      const scope = value.slice(match.index, nextOther?.index);
      if (scope.includes(quote)) scopes.push(scope);
    }
  }
  return scopes;
}

export function pieceCounts(text: string): number[] {
  const body = text.replace(mawbPattern, ' ');
  const labeled = [...body.matchAll(/(?:件数|\bpieces\b|\bpcs\b)\s*[:：]?\s*(\d+)/giu)];
  const suffixed = [...body.matchAll(/(?<![\d:./-])(\d+)\s*(?:件(?!数)|pieces\b|pcs\b)/giu)];
  return [...labeled, ...suffixed].map(m => Number(m[1]));
}

function routeAndFlight(text: string, segment: Segment): { matches: boolean; flightOccurrences: number } {
  if (!segment.flightNumber || !segment.origin || !segment.destination) return { matches: false, flightOccurrences: 0 };
  const wantedFlight = segment.flightNumber.replace(/\s/gu, '');
  const airports = [...text.matchAll(/\b[A-Z]{3}\b/gu)].map(m => m[0])
    .filter(code => !nonAirportCodes.has(code) || code === segment.origin || code === segment.destination);
  const flights = [...text.matchAll(flightPattern)].filter(m => {
    const prefix = m[0].match(/^[A-Z]{2,3}/u)?.[0];
    return !prefix || (!nonAirportCodes.has(prefix) && prefix !== segment.origin && prefix !== segment.destination);
  }).map(m => m[0].replace(/\s/gu, ''));
  return { matches: airports.includes(segment.origin) && airports.includes(segment.destination)
    && airports.every(code => code === segment.origin || code === segment.destination)
    && flights.includes(wantedFlight) && flights.every(flight => flight === wantedFlight), flightOccurrences: flights.length };
}

/** Resolve a quote to an unambiguous shipment context; never borrow identifiers from other records. */
export function timeContext(mawb: string, text: string, rawQuote: string, segment: Segment, totalPieces: number | null): string | undefined {
  const quote = compact(rawQuote);
  for (const scope of shipmentScopes(text, mawb, quote)) {
    const identity = routeAndFlight(scope, segment);
    const counts = pieceCounts(scope);
    const fullShipment = Boolean(totalPieces && segment.pieces === totalPieces && counts.length
      && counts.every(n => n === totalPieces));
    // A shared header can support short quotes only when it identifies one route/flight.
    // Repeated flight nodes additionally require the full, unchanged shipment quantity.
    if (identity.matches && (identity.flightOccurrences === 1 || fullShipment)
      && (!counts.length || counts.every(n => n === segment.pieces))) return scope;
    // Richer quotes remain usable on pages with several flights or split shipments.
    if (routeAndFlight(quote, segment).matches && pieceCounts(quote).every(n => n === segment.pieces)) return quote;
  }
  return undefined;
}
