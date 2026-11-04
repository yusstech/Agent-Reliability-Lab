import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderClient } from '../../src/providers/client.ts';

// A raw HTTP server lets us produce responses no provider route would: stalled bodies,
// arbitrary status codes.
let server: Server;
let client: ProviderClient;
beforeAll(async () => {
  server = createServer((req, res) => {
    const status = Number(req.url?.slice(1));
    if (req.url === '/stall-body') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":');
      return; // never finishes
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: `CODE_${status}` } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  client = new ProviderClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 150 });
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

describe('outcome classification', () => {
  it('CL-01 4xx and 501 are definitive; other 5xx are unknown', async () => {
    expect(await client.request('GET', '/404')).toEqual({ kind: 'rejected', status: 404, code: 'CODE_404' });
    expect(await client.request('GET', '/429')).toEqual({ kind: 'rejected', status: 429, code: 'CODE_429' });
    expect(await client.request('GET', '/501')).toEqual({ kind: 'rejected', status: 501, code: 'CODE_501' });
    expect(await client.request('GET', '/500')).toEqual({ kind: 'unknown', reason: 'server_error', status: 500, code: 'CODE_500' });
    expect(await client.request('GET', '/503')).toEqual({ kind: 'unknown', reason: 'server_error', status: 503, code: 'CODE_503' });
  });

  it('CL-02 a timeout while reading a 2xx body is reported as a timeout', async () => {
    expect(await client.request('GET', '/stall-body')).toEqual({ kind: 'unknown', reason: 'timeout', status: 200 });
  });

  it('CL-03 an unreachable provider is an unknown connection error', async () => {
    const dead = new ProviderClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 150 });
    expect(await dead.request('GET', '/x')).toEqual({ kind: 'unknown', reason: 'connection_error' });
  });
});
