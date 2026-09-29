import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const DIRECTORY_URL = 'https://www.track-trace.com/aircargo';
export const actualTimeSchema = z.object({
  value: z.string().max(100), label: z.enum(['ATD', 'ATA', 'DEP', 'ARR', 'Actual Departure', 'Actual Arrival']),
  evidenceId: z.string().uuid(), quote: z.string().min(10).max(5000),
}).strict();
const nullableText = z.string().max(200).nullable();
export const segmentSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
  transportType: z.enum(['air', 'road']), group: nullableText,
  origin: z.string().regex(/^[A-Z]{3}$/).nullable(), destination: z.string().regex(/^[A-Z]{3}$/).nullable(),
  flightNumber: nullableText, flightDate: nullableText, pieces: z.number().int().nonnegative().nullable(),
  actualDeparture: actualTimeSchema.nullable(), actualArrival: actualTimeSchema.nullable(),
}).strict();
export const shipmentSchema = z.object({
  mawb: z.string().regex(/^\d{3}-\d{8}$/),
  status: z.enum(['complete', 'partial', 'not_found', 'blocked']),
  carrier: nullableText, origin: z.string().regex(/^[A-Z]{3}$/).nullable(),
  destination: z.string().regex(/^[A-Z]{3}$/).nullable(), pieces: z.number().int().nonnegative().nullable(),
  weight: nullableText, journeyComplete: z.boolean(),
  completionEvidenceId: z.string().uuid().nullable(), completionQuote: z.string().max(5000).nullable(),
  segments: z.array(segmentSchema).max(100),
  issues: z.array(z.object({
    code: z.string().max(80), message: z.string().max(1500),
    segmentId: z.string().max(60).nullable(), field: z.enum(['departure', 'arrival', 'general']),
    values: z.array(z.string().max(200)).max(10),
  }).strict()).max(100),
  evidenceIds: z.array(z.string().uuid()).max(100),
}).strict();
export const outputSchema = zodToJsonSchema(shipmentSchema, { target: 'openAi', $refStrategy: 'none' });
export type Shipment = z.infer<typeof shipmentSchema>;
export type Segment = z.infer<typeof segmentSchema>;
export type ActualTime = z.infer<typeof actualTimeSchema>;
export interface Evidence {
  id: string; jobId: string; attempt: number; url: string; capturedAt: string;
  text: string; sha256: string; screenshot: boolean; sequence: number;
  kind: 'page' | 'navigation_attempt';
}
export interface SummaryTime { value: string | null; kind: 'value' | 'missing' | 'multiple' | 'conflict'; note: string }
export interface ValidatedShipment extends Shipment {
  summary: { atd: SummaryTime; ata: SummaryTime };
  checkedAt: string; sourceUrls: string[];
}
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'not_found' | 'blocked' | 'failed' | 'cancelled' | 'invalid_input';
export const terminalStatuses: JobStatus[] = ['succeeded', 'partial', 'not_found', 'blocked', 'failed', 'cancelled', 'invalid_input'];
export interface Job {
  id: string; batchId: string; owner: string; mawb: string; status: JobStatus;
  attempt: number; maxAttempts: number; availableAt: number; leaseUntil: number | null;
  workerId: string | null; cancelRequested: boolean; stage: string;
  result: ValidatedShipment | null; errorCode: string | null; createdAt: string; updatedAt: string;
}
export class ServiceError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
export function normalizeMawb(value: string): string | null {
  const digits = value.normalize('NFKC').trim().replace(/[\s‐‑–—-]/gu, '');
  return /^\d{11}$/.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3)}` : null;
}
export function parseMawbs(input: string | string[]): { values: string[]; duplicates: number } {
  const tokens = Array.isArray(input) ? input : input.normalize('NFKC')
    .replace(/(\d{3})[ \t]*[‐‑–—-][ \t]*(\d{8})/gu, '$1-$2')
    .replace(/\b(\d{3})[ \t]+(\d{8})\b/gu, '$1-$2').split(/[\s,，;；、]+/u);
  const normalized = tokens.map(t => normalizeMawb(t) ?? t.trim()).filter(Boolean);
  if (!normalized.length || normalized.length > 100 || normalized.some(t => t.length > 120)) {
    throw new ServiceError(400, 'invalid_batch', '每批请输入 1–100 个提单号，每项最多 120 字符。');
  }
  const values = [...new Set(normalized)];
  return { values, duplicates: normalized.length - values.length };
}
export function emptyShipment(mawb: string, code: string, message: string): Shipment {
  return { mawb, status: 'blocked', carrier: null, origin: null, destination: null, pieces: null,
    weight: null, journeyComplete: false, completionEvidenceId: null, completionQuote: null,
    segments: [], issues: [{ code, message, segmentId: null, field: 'general', values: [] }], evidenceIds: [] };
}
