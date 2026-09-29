import { outputSchema } from './domain.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { shipmentSchema } from './domain.js';
const time = z.object({ value: z.string().nullable(), kind: z.enum(['value', 'missing', 'multiple', 'conflict']), note: z.string() });
const validated = shipmentSchema.extend({ summary: z.object({ atd: time, ata: time }), checkedAt: z.string(), sourceUrls: z.array(z.string()) });
const job = z.object({ id: z.string().uuid(), batchId: z.string().uuid(), mawb: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'partial', 'not_found', 'blocked', 'failed', 'cancelled', 'invalid_input']),
  attempt: z.number().int(), maxAttempts: z.number().int(), cancelRequested: z.boolean(), stage: z.string(),
  result: validated.nullable(), errorCode: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() });
const batch = z.object({ id: z.string().uuid(), createdAt: z.string(), duplicates: z.number().int(), total: z.number().int(),
  finished: z.number().int(), status: z.enum(['queued', 'running', 'finished']), jobs: z.array(job), reused: z.boolean().optional() });
const schema = (value: z.ZodTypeAny) => zodToJsonSchema(value, { target: 'jsonSchema7', $refStrategy: 'none' });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const response = (description: string, schema: object = { type: 'object' }) => ({ description, content: { 'application/json': { schema } } });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const basic = { parameters: [idParam], responses: { '200': response('成功'), '401': response('未认证'), '404': response('资源不存在或不属于当前用户') } };
export const openApiDocument = {
  openapi: '3.1.0', info: { title: 'Codex Flight Service', version: '0.1.0', description: '空运提单异步查询。所有业务请求须由可信服务端发送服务密钥与 X-User-Id。' },
  servers: [{ url: 'https://flight.example.com' }], security: [{ ServiceToken: [], UserId: [] }],
  components: { securitySchemes: {
    ServiceToken: { type: 'http', scheme: 'bearer' }, UserId: { type: 'apiKey', in: 'header', name: 'X-User-Id' },
  }, schemas: { ModelShipment: outputSchema, Shipment: schema(validated), Job: schema(job), Batch: schema(batch),
    Error: { type: 'object', required: ['error', 'requestId'], properties: {
      error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'] }, requestId: { type: 'string' },
    } },
  } },
  paths: {
    '/healthz': { get: { summary: '进程存活检查', security: [], responses: { '200': response('存活') } } },
    '/readyz': { get: { summary: '检查最近 30 秒有无 Worker 心跳', responses: { '200': response('就绪'), '503': response('没有活跃 Worker') } } },
    '/openapi.json': { get: { summary: '本接口规范', responses: { '200': response('OpenAPI 3.1') } } },
    '/v1/batches': {
      post: { summary: '提交批量查询', parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['mawbs'], properties: {
          mawbs: { oneOf: [{ type: 'string', maxLength: 15000 }, { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', maxLength: 120 } }] },
        } }, example: { mawbs: ['176-65598013'] } } } },
        responses: { '202': response('新批次', ref('Batch')), '200': response('相同幂等请求', ref('Batch')), '409': response('幂等键冲突', ref('Error')), '429': response('队列已满或限流', ref('Error')) } },
      get: { summary: '列出当前用户历史批次', parameters: [
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 20, default: 10 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
      ], responses: { '200': response('批次列表') } },
    },
    '/v1/batches/{id}': { get: { ...basic, summary: '查询批次进度及逐票结果', responses: { ...basic.responses, '200': response('批次', ref('Batch')) } } },
    '/v1/batches/{id}/cancel': { post: { ...basic, summary: '取消排队与执行中的任务；已完成结果保留' } },
    '/v1/jobs/{id}': { get: { ...basic, summary: '查询单票结果', responses: { ...basic.responses, '200': response('单票结果', ref('Job')) } } },
    '/v1/jobs/{id}/retry': { post: { ...basic, summary: '重查失败、不完整或已取消任务', responses: { '202': response('已排队'), '409': response('状态不可重试或执行次数已达上限') } } },
    '/v1/jobs/{id}/events': { get: { ...basic, summary: '读取脱敏业务事件', parameters: [idParam, { name: 'after', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } }] } },
    '/v1/jobs/{id}/evidence': { get: { ...basic, summary: '列出当前或指定执行次数的证据', parameters: [idParam, { name: 'attempt', in: 'query', schema: { type: 'integer', minimum: 1 } }] } },
    '/v1/jobs/{id}/evidence/{evidenceId}': { get: { ...basic, summary: '读取原文与来源', parameters: [idParam,
      { name: 'evidenceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'attempt', in: 'query', schema: { type: 'integer', minimum: 1 } }] } },
    '/v1/jobs/{id}/evidence/{evidenceId}/screenshot': { get: { summary: '读取证据截图', parameters: [idParam,
      { name: 'evidenceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'attempt', in: 'query', schema: { type: 'integer', minimum: 1 } }],
      responses: { '200': { description: 'PNG 截图', content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } }, '404': response('没有截图或无权限') } } },
  },
};
