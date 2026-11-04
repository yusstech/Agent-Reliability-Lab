import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { generateFixture } from '../../fixtures/generate.ts';
import { buildApp } from '../../src/app.ts';
import { createPool } from '../../src/db/pool.ts';
import { seed } from '../../src/db/seed.ts';
import { createTestPool } from '../helpers/db.ts';

const pool: pg.Pool = createTestPool();
let app: FastifyInstance;
const auth = { authorization: 'Bearer mock_session_cus_001' };
const valid = { order_id: 'ord_1001', new_address_id: 'addr_002', idempotency_key: 'req_73a8' };

beforeAll(async () => {
  await seed(pool, generateFixture());
  app = buildApp({ pool });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const UUID = /^[0-9a-f-]{36}$/;

function expectEnvelope(res: { json(): any; headers: Record<string, unknown> }, code: string) {
  const body = res.json();
  expect(Object.keys(body)).toEqual(['error']);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
  expect(body.error.request_id).toMatch(UUID);
  expect(res.headers['x-request-id']).toBe(body.error.request_id);
  return body.error;
}

describe('HTTP foundation', () => {
  it('API-01 /health reports database and schema version', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', database: 'ok', schema_version: '0002_provider_services' });
  });

  it('API-02 /health returns 503 DEPENDENCY_UNAVAILABLE when the database is unreachable', async () => {
    const deadPool = createPool('postgres://nobody:none@127.0.0.1:1/none');
    const deadApp = buildApp({ pool: deadPool });
    const res = await deadApp.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expectEnvelope(res, 'DEPENDENCY_UNAVAILABLE');
    await deadApp.close();
    await deadPool.end();
  });

  it('API-02b authenticated routes return 503, not 500, when the session store is unreachable', async () => {
    const deadPool = createPool('postgres://nobody:none@127.0.0.1:1/none');
    const deadApp = buildApp({ pool: deadPool });
    const res = await deadApp.inject({ method: 'GET', url: '/v1/session', headers: auth });
    expect(res.statusCode).toBe(503);
    expectEnvelope(res, 'DEPENDENCY_UNAVAILABLE');
    await deadApp.close();
    await deadPool.end();
  });

  it('API-03 identity is derived from the server-side session', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/session', headers: { authorization: 'Bearer mock_session_cus_003' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ customer_id: 'cus_003', auth_mode: 'mock_session' });
  });

  it('API-04 missing, malformed and unknown tokens get one indistinguishable 401', async () => {
    const variants = [{}, { authorization: 'mock_session_cus_001' }, { authorization: 'Bearer ' }, { authorization: 'Bearer mock_session_cus_999' }];
    const messages = new Set<string>();
    for (const headers of variants) {
      const res = await app.inject({ method: 'GET', url: '/v1/session', headers });
      expect(res.statusCode).toBe(401);
      messages.add(expectEnvelope(res, 'UNAUTHENTICATED').message);
    }
    expect(messages.size).toBe(1);
  });

  it('API-05 authentication runs before validation and before the body is parsed', async () => {
    const url = '/v1/address-change-requests';
    const attempts = [
      { payload: { nonsense: true } },
      { headers: { 'content-type': 'application/json' }, payload: '{"order_id":' },
      { headers: { 'content-type': 'text/plain' }, payload: 'hello' },
      { payload: { message: 'x'.repeat(20_000) } },
    ];
    for (const a of attempts) {
      const res = await app.inject({ method: 'POST', url, ...a });
      expect(res.statusCode).toBe(401);
      expectEnvelope(res, 'UNAUTHENTICATED');
    }
  });

  it('API-05b the Bearer scheme is matched case-insensitively; the token is not', async () => {
    const ok = await app.inject({ method: 'GET', url: '/v1/session', headers: { authorization: 'bearer mock_session_cus_002' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().customer_id).toBe('cus_002');
    const wrongCase = await app.inject({ method: 'GET', url: '/v1/session', headers: { authorization: 'Bearer MOCK_SESSION_CUS_002' } });
    expect(wrongCase.statusCode).toBe(401);
  });

  it('API-06 a body-supplied customer_id is rejected, not trusted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/address-change-requests',
      headers: auth,
      payload: { ...valid, customer_id: 'cus_002' },
    });
    expect(res.statusCode).toBe(400);
    expect(expectEnvelope(res, 'VALIDATION_FAILED').details).toEqual([
      { path: 'customer_id', issue: 'unrecognized_key', message: 'field is not accepted' },
    ]);
  });

  it('API-07 invalid fields return stable field-level details', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/address-change-requests', headers: auth, payload: { order_id: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(expectEnvelope(res, 'VALIDATION_FAILED').details.map((d: any) => `${d.path}:${d.issue}`)).toEqual([
      'idempotency_key:required',
      'new_address_id:required',
      'order_id:invalid_format',
    ]);
  });

  it('API-08 malformed JSON, wrong content type and oversized bodies map to stable codes', async () => {
    const url = '/v1/address-change-requests';
    const badJson = await app.inject({ method: 'POST', url, headers: { ...auth, 'content-type': 'application/json' }, payload: '{"order_id":' });
    expect(badJson.statusCode).toBe(400);
    expectEnvelope(badJson, 'MALFORMED_JSON');

    const empty = await app.inject({ method: 'POST', url, headers: { ...auth, 'content-type': 'application/json' }, payload: '' });
    expect(empty.statusCode).toBe(400);
    expectEnvelope(empty, 'MALFORMED_JSON');

    const text = await app.inject({ method: 'POST', url, headers: { ...auth, 'content-type': 'text/plain' }, payload: 'hello' });
    expect(text.statusCode).toBe(415);
    expectEnvelope(text, 'UNSUPPORTED_MEDIA_TYPE');

    // An unlisted framework 4xx keeps its status instead of becoming 500 INTERNAL.
    const badLength = await app.inject({ method: 'POST', url, headers: { ...auth, 'content-type': 'application/json', 'content-length': '2' }, payload: JSON.stringify(valid) });
    expect(badLength.statusCode).toBe(400);
    expectEnvelope(badLength, 'BAD_REQUEST');

    const big = await app.inject({ method: 'POST', url, headers: auth, payload: { ...valid, message: 'x'.repeat(20_000) } });
    expect(big.statusCode).toBe(413);
    expectEnvelope(big, 'PAYLOAD_TOO_LARGE');
  });

  it('API-09 a valid request reaches the Phase 03 boundary and writes nothing', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/address-change-requests', headers: auth, payload: valid });
    expect(res.statusCode).toBe(501);
    expectEnvelope(res, 'NOT_IMPLEMENTED');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM ledger.operations');
    expect(rows[0].n).toBe(0);
  });

  it('API-10 unknown routes use the envelope; client request ids are not trusted', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/nope', headers: { 'request-id': 'attacker-chosen' } });
    expect(res.statusCode).toBe(404);
    expect(expectEnvelope(res, 'ROUTE_NOT_FOUND').request_id).not.toBe('attacker-chosen');
  });
});
