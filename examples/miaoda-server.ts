/**
 * 妙搭服务端调用示例。不要在前端引入本文件或暴露 SERVICE_KEY。
 * 在应用内使用其规定的 HttpService/axiosForBackend 时，保留这些请求头和身份边界。
 */
export class FlightServiceClient {
  constructor(private readonly baseUrl: string, private readonly serviceKey: string) {
    if (!baseUrl.startsWith('https://')) throw new Error('生产服务必须使用 HTTPS');
  }
  private async request(path: string, verifiedUserId: string, method = 'GET', body?: unknown, idempotencyKey?: string) {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.serviceKey}`,
        'X-User-Id': verifiedUserId,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Flight service HTTP ${response.status}`);
    return response.json();
  }
  submit(verifiedUserId: string, mawbs: string[], idempotencyKey: string) {
    return this.request('/v1/batches', verifiedUserId, 'POST', { mawbs }, idempotencyKey);
  }
  batch(verifiedUserId: string, id: string) { return this.request(`/v1/batches/${encodeURIComponent(id)}`, verifiedUserId); }
  history(verifiedUserId: string) { return this.request('/v1/batches', verifiedUserId); }
  cancel(verifiedUserId: string, id: string) { return this.request(`/v1/batches/${encodeURIComponent(id)}/cancel`, verifiedUserId, 'POST'); }
  retry(verifiedUserId: string, id: string) { return this.request(`/v1/jobs/${encodeURIComponent(id)}/retry`, verifiedUserId, 'POST'); }
  evidence(verifiedUserId: string, id: string) { return this.request(`/v1/jobs/${encodeURIComponent(id)}/evidence`, verifiedUserId); }
}
