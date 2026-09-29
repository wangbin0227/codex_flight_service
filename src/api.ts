import Fastify, { type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import { Store } from './store.js';
import { ServiceError, type Job } from './domain.js';
import { evidenceSchema } from './evidence.js';
import { openApiDocument } from './openapi.js';

const input = z.object({ mawbs: z.union([z.string().min(1).max(15000), z.array(z.string().min(1).max(120)).min(1).max(100)]) }).strict();
const uuid = z.string().uuid();
const paging = z.object({ limit: z.coerce.number().int().min(1).max(20).default(10), offset: z.coerce.number().int().min(0).max(100000).default(0) });
function safeEqual(a: string, b: string) { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
function publicJob(job: Job) {
  const { owner: _owner, workerId: _worker, leaseUntil: _lease, availableAt: _available, ...value } = job;
  return value;
}
function publicBatch(batch: ReturnType<Store['getBatch']>) { return { ...batch, jobs: batch.jobs.map(publicJob) }; }

export function createApp(config: Config, store: Store) {
  const app = Fastify({ bodyLimit: 20000, requestTimeout: 15000, logger: { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] }, logController: new Fastify.LogController({ disableRequestLogging: true }) });
  const owners = new WeakMap<FastifyRequest, string>();
  const owner = (req: FastifyRequest) => owners.get(req)!;
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    if (req.method === 'GET' && req.url === '/healthz') return;
    const bearer = req.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
    const tenant = bearer ? Object.entries(config.apiKeys).find(([, key]) => safeEqual(key, bearer))?.[0] : undefined;
    if (!tenant) throw new ServiceError(401, 'unauthorized', '缺少或无效的服务凭证。');
    const user = z.string().regex(/^[a-zA-Z0-9_.@-]{1,128}$/).safeParse(req.headers['x-user-id']);
    if (!user.success) throw new ServiceError(400, 'user_required', '需要 X-User-Id，由可信服务端传入当前用户标识。');
    owners.set(req, `${tenant}:${user.data}`);
    if (!store.rateLimit(`${tenant}:${user.data}`, config.requestLimit)) {
      reply.header('Retry-After', '60'); throw new ServiceError(429, 'rate_limited', '请求频率过高，请稍后重试。');
    }
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message }, requestId: req.id });
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'invalid_request', message: '请求字段格式错误。' }, requestId: req.id });
    const errorStatus = error instanceof Error && 'statusCode' in error ? Number(error.statusCode) : 500;
    const status = errorStatus >= 400 && errorStatus < 500 ? errorStatus : 500;
    // Raw exceptions may include provider credentials, browser content or subprocess output.
    req.log.error({ event: 'request_failed', status, requestId: req.id });
    return reply.code(status).send({ error: { code: status === 500 ? 'internal_error' : 'invalid_request', message: status === 500 ? '服务暂时不可用。' : '请求无效。' }, requestId: req.id });
  });
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => { const ready = store.ready(); return reply.code(ready ? 200 : 503).send({ ready, workerAlive: ready }); });
  app.get('/openapi.json', async () => openApiDocument);
  app.post('/v1/batches', async (req, reply) => {
    const body = input.parse(req.body);
    const idem = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(req.headers['idempotency-key']);
    const result = store.createBatch(owner(req), idem, body.mawbs);
    return reply.code(result.reused ? 200 : 202).header('Location', `/v1/batches/${result.batch.id}`)
      .send({ ...publicBatch(result.batch), reused: result.reused });
  });
  app.get('/v1/batches', async req => { const p = paging.parse(req.query); return { items: store.listBatches(owner(req), p.limit, p.offset).map(publicBatch), ...p }; });
  app.get('/v1/batches/:id', async req => publicBatch(store.getBatch(uuid.parse((req.params as { id: string }).id), owner(req))));
  app.post('/v1/batches/:id/cancel', async req => publicBatch(store.cancelBatch(uuid.parse((req.params as { id: string }).id), owner(req))));
  app.get('/v1/jobs/:id', async req => publicJob(store.getJob(uuid.parse((req.params as { id: string }).id), owner(req))));
  app.post('/v1/jobs/:id/retry', async (req, reply) => reply.code(202).send(publicJob(store.retryJob(uuid.parse((req.params as { id: string }).id), owner(req)))));
  app.get('/v1/jobs/:id/events', async req => {
    const id = uuid.parse((req.params as { id: string }).id);
    const after = z.coerce.number().int().nonnegative().default(0).parse((req.query as { after?: string }).after);
    return { items: store.events(id, owner(req), after) };
  });
  const evidencePath = (job: Job, attempt: number) => join(config.dataDir, 'evidence', job.id, String(attempt));
  const resolveJobAttempt = (req: FastifyRequest) => {
    const job = store.getJob(uuid.parse((req.params as { id: string }).id), owner(req));
    const attempt = z.coerce.number().int().min(1).max(Math.max(1, job.attempt)).default(Math.max(1, job.attempt)).parse((req.query as { attempt?: string }).attempt);
    return { job, attempt, dir: evidencePath(job, attempt) };
  };
  app.get('/v1/jobs/:id/evidence', async req => {
    const { job, attempt, dir } = resolveJobAttempt(req);
    const names = await readdir(dir).catch(() => [] as string[]);
    const items = [];
    for (const name of names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).slice(0, 150)) {
      const entry = evidenceSchema.parse(JSON.parse(await readFile(join(dir, name), 'utf8')));
      const { text: _text, ...meta } = entry;
      items.push({ ...meta, textUrl: `/v1/jobs/${job.id}/evidence/${entry.id}?attempt=${attempt}`,
        screenshotUrl: entry.screenshot ? `/v1/jobs/${job.id}/evidence/${entry.id}/screenshot?attempt=${attempt}` : null });
    }
    return { attempt, items: items.sort((a, b) => a.sequence - b.sequence) };
  });
  const getEvidence = async (req: FastifyRequest) => {
    const { job, attempt, dir } = resolveJobAttempt(req);
    const evidenceId = uuid.parse((req.params as { evidenceId: string }).evidenceId);
    let raw: string;
    try { raw = await readFile(join(dir, `${evidenceId}.json`), 'utf8'); }
    catch { throw new ServiceError(404, 'not_found', '证据不存在。'); }
    const entry = evidenceSchema.parse(JSON.parse(raw));
    if (entry.jobId !== job.id || entry.attempt !== attempt) throw new ServiceError(404, 'not_found', '证据不存在。');
    return { entry, dir };
  };
  app.get('/v1/jobs/:id/evidence/:evidenceId', async req => (await getEvidence(req)).entry);
  app.get('/v1/jobs/:id/evidence/:evidenceId/screenshot', async (req, reply) => {
    const { entry, dir } = await getEvidence(req);
    if (!entry.screenshot) throw new ServiceError(404, 'not_found', '此证据没有截图。');
    return reply.type('image/png').header('Content-Disposition', 'inline; filename="evidence.png"')
      .send(await readFile(join(dir, `${entry.id}.png`)));
  });
  return app;
}
