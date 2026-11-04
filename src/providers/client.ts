// HTTP client for the mock providers that classifies every outcome (ADR-0008).
// The rule that matters: a timeout, connection error or 5xx is UNKNOWN, never failure.
// A mutation that ends UNKNOWN may or may not have been applied. The one 5xx exception
// is 501 Not Implemented: a permanent statement about the API, not about this request.

export type Outcome<T> =
  | { kind: 'ok'; status: number; body: T; replayed: boolean }
  /** Definitive answer (4xx, or 501): the request was not applied / is not supported. */
  | { kind: 'rejected'; status: number; code: string }
  | { kind: 'unknown'; reason: 'timeout' | 'connection_error' | 'server_error'; status?: number; code?: string };

export interface ProviderClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  /** Sent on every request, e.g. { 'x-acting-customer-id': 'cus_001' }. */
  headers?: Record<string, string>;
}

async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === 'string' ? body.error.code : undefined;
  } catch {
    return undefined;
  }
}

export class ProviderClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor({ baseUrl, timeoutMs = 2000, headers = {} }: ProviderClientOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.headers = headers;
  }

  withHeaders(headers: Record<string, string>): ProviderClient {
    return new ProviderClient({ baseUrl: this.baseUrl, timeoutMs: this.timeoutMs, headers: { ...this.headers, ...headers } });
  }

  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<Outcome<T>> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { ...this.headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string }).name;
      return { kind: 'unknown', reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'connection_error' };
    }
    if (res.status === 501) return { kind: 'rejected', status: res.status, code: (await errorCode(res)) ?? 'NOT_SUPPORTED' };
    if (res.status >= 500) return { kind: 'unknown', reason: 'server_error', status: res.status, code: await errorCode(res) };
    if (res.status >= 400) return { kind: 'rejected', status: res.status, code: (await errorCode(res)) ?? 'UNKNOWN_ERROR' };
    try {
      return { kind: 'ok', status: res.status, body: (await res.json()) as T, replayed: res.headers.get('idempotent-replayed') === 'true' };
    } catch {
      // A 2xx with an unreadable body tells us nothing reliable about the side effect.
      return { kind: 'unknown', reason: 'server_error', status: res.status };
    }
  }
}
