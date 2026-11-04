import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixture, startStack, type Stack, target } from '../helpers/stack.ts';

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(() => s.close());
beforeEach(() => s.reset());

const other = fixture.customers.find((c) => c.id !== target.customer_id)!.id;
const othersOrder = fixture.orders.find((o) => o.customer_id === other)!;
const othersAddress = fixture.saved_addresses.find((a) => a.customer_id === other)!;
const shipped = fixture.orders.find((o) => o.customer_id === target.customer_id && o.status === 'SHIPPED')
  ?? fixture.orders.find((o) => o.status === 'SHIPPED')!;
const body = (over: Record<string, unknown> = {}) => ({ order_id: target.order_id, new_address_id: target.to_address_id, idempotency_key: 'req_rq_00001', ...over });
const noSideEffects = async () => expect(await s.truth()).toMatchObject({ order_mutations: 0, carrier_mutations: 0 });

describe('request path: authorization and eligibility (I1–I4)', () => {
  it('RQ-01 a valid request is recorded as NEEDS_CONFIRMATION with a one-time token', async () => {
    const res = await s.submit(body());
    expect(res.statusCode).toBe(202);
    const r = res.json();
    expect(r).toMatchObject({ status: 'NEEDS_CONFIRMATION', customer_status: 'pending', order_id: target.order_id, target_address_id: target.to_address_id });
    expect(r.confirmation.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const stored = (await s.pool.query('SELECT token_sha256 FROM ledger.confirmations WHERE operation_id = $1', [r.operation_id])).rows[0];
    expect(stored.token_sha256).not.toBe(r.confirmation.token);
    await noSideEffects();
  });

  it("RQ-02 another customer's order is not found, and the attempt is recorded as REJECTED", async () => {
    const res = await s.submit(body({ order_id: othersOrder.id }));
    expect(res.statusCode).toBe(404);
    const err = res.json().error;
    expect(err.code).toBe('ORDER_NOT_FOUND');
    expect((await s.pool.query('SELECT status, public_reason FROM ledger.operations WHERE id = $1', [err.operation_id])).rows[0]).toEqual({ status: 'REJECTED', public_reason: 'ORDER_NOT_FOUND' });
    await noSideEffects();
  });

  it("RQ-03 another customer's saved address is refused", async () => {
    const res = await s.submit(body({ new_address_id: othersAddress.id }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('ADDRESS_NOT_FOUND');
    await noSideEffects();
  });

  it('RQ-04 shipped orders and unchanged addresses are refused', async () => {
    const owner = shipped.customer_id;
    const alt = fixture.saved_addresses.find((a) => a.customer_id === owner && a.id !== shipped.address_id)!;
    const ship = await s.submit({ order_id: shipped.id, new_address_id: alt.id, idempotency_key: 'req_rq_ship1' }, owner);
    expect(ship.json().error.code).toBe('ORDER_NOT_ELIGIBLE');
    const same = await s.submit(body({ new_address_id: target.from_address_id }));
    expect(same.json().error.code).toBe('ADDRESS_UNCHANGED');
    await noSideEffects();
  });

  it("RQ-05 a refused request on another customer's order cannot reveal that order's in-flight operation", async () => {
    const victimTarget = fixture.saved_addresses.find((a) => a.customer_id === other && a.id !== othersOrder.address_id)!;
    const victim = await s.submit({ order_id: othersOrder.id, new_address_id: victimTarget.id, idempotency_key: 'req_victim_1' }, other);
    expect([202, 422]).toContain(victim.statusCode);
    const probe = await s.submit(body({ order_id: othersOrder.id, idempotency_key: 'req_probe_01' }));
    expect(probe.json().error.code).toBe('ORDER_NOT_FOUND');
  });

  it('RQ-06 an unavailable order system records nothing and asks for a retry', async () => {
    await s.faults('order', { rules: [{ fault: 'UNAVAILABLE_STATUS_QUERY', target: '*', on: 'read' }] });
    const res = await s.submit(body());
    expect(res.statusCode).toBe(503);
    expect((await s.pool.query('SELECT count(*)::int AS n FROM ledger.operations')).rows[0].n).toBe(0);
    expect((await s.submit(body())).statusCode).toBe(202);
  });
});

describe('request path: idempotency and concurrency (I6, I7)', () => {
  it('RQ-07 the same key and payload returns the same operation; message is not part of the fingerprint', async () => {
    const first = (await s.submit(body())).json();
    const again = await s.submit(body({ message: 'different wording is not part of the fingerprint' }));
    expect(again.statusCode).toBe(200);
    expect(again.json().operation_id).toBe(first.operation_id);
    expect((await s.pool.query('SELECT count(*)::int AS n FROM ledger.operations')).rows[0].n).toBe(1);
  });

  it('RQ-11 a client that lost the 202 replays and gets a fresh token; the old one stops working', async () => {
    const first = (await s.submit(body())).json();
    const again = (await s.submit(body())).json();
    expect(again.confirmation.token).not.toBe(first.confirmation.token);
    expect(again.confirmation.expires_at).toBe(first.confirmation.expires_at); // no extension
    expect((await s.confirm(first.operation_id, first.confirmation.token)).json().error.code).toBe('CONFIRMATION_INVALID');
    expect((await s.confirm(first.operation_id, again.confirmation.token)).json().status).toBe('QUEUED');
    // Once confirmed, a replay issues nothing new.
    expect((await s.submit(body())).json().confirmation).toBeUndefined();
  });

  it('RQ-08 the same key with a different payload is refused', async () => {
    await s.submit(body());
    const alt = fixture.saved_addresses.find((a) => a.customer_id === target.customer_id && ![target.from_address_id, target.to_address_id].includes(a.id));
    const res = await s.submit(body({ new_address_id: alt?.id ?? target.from_address_id }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('RQ-09 a second change for the same order is refused while the first is unresolved', async () => {
    await s.submit(body());
    const res = await s.submit(body({ idempotency_key: 'req_rq_00002' }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('OPERATION_IN_PROGRESS');
  });

  it('RQ-10 concurrent identical submissions create exactly one operation', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => s.submit(body())));
    expect(new Set(results.map((r) => r.json().operation_id)).size).toBe(1);
    expect(results.filter((r) => r.statusCode === 202)).toHaveLength(1);
  });
});

describe('consent (I5)', () => {
  const created = async () => (await s.submit(body())).json();

  it('CF-01 the right token from the owner queues the operation; repeating it is harmless', async () => {
    const c = await created();
    const ok = await s.confirm(c.operation_id, c.confirmation.token);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('QUEUED');
    expect((await s.confirm(c.operation_id, c.confirmation.token)).json().status).toBe('QUEUED');
  });

  it('CF-02 a wrong token, a boolean flag, or another customer cannot confirm', async () => {
    const c = await created();
    expect((await s.confirm(c.operation_id, 'A'.repeat(22))).json().error.code).toBe('CONFIRMATION_INVALID');
    const flag = await s.app.inject({ method: 'POST', url: `/v1/operations/${c.operation_id}/confirm`, headers: { authorization: `Bearer mock_session_${target.customer_id}` }, payload: { confirmed: true } });
    expect(flag.statusCode).toBe(400);
    expect((await s.confirm(c.operation_id, c.confirmation.token, other)).json().error.code).toBe('OPERATION_NOT_FOUND');
    expect((await s.view(c.operation_id)).status).toBe('NEEDS_CONFIRMATION');
  });

  it('CF-03 an expired challenge rejects the operation and frees the order', async () => {
    const short = await startStack({ confirmationTtlMs: 1 });
    try {
      await short.reset();
      const c = (await short.submit(body())).json();
      await new Promise((r) => setTimeout(r, 20));
      const res = await short.confirm(c.operation_id, c.confirmation.token);
      expect(res.statusCode).toBe(410);
      expect((await short.view(c.operation_id)).customer_status).toBe('not_changed');
      expect((await short.submit(body({ idempotency_key: 'req_rq_after' }))).statusCode).toBe(202);
    } finally {
      await short.close();
    }
  });

  it('CF-05 confirming after the worker swept the challenge answers 410, like before the sweep', async () => {
    const short = await startStack({ confirmationTtlMs: 1 });
    try {
      await short.reset();
      const c = (await short.submit(body())).json();
      await new Promise((r) => setTimeout(r, 20));
      await short.worker().runUntilIdle();
      const res = await short.confirm(c.operation_id, c.confirmation.token);
      expect(res.statusCode).toBe(410);
      expect(res.json().error.code).toBe('CONFIRMATION_EXPIRED');
    } finally {
      await short.close();
    }
  });

  it('CF-04 the worker sweeps expired challenges; nothing is executed without consent', async () => {
    const short = await startStack({ confirmationTtlMs: 1 });
    try {
      await short.reset();
      const c = (await short.submit(body())).json();
      await new Promise((r) => setTimeout(r, 20));
      await short.worker().runUntilIdle();
      expect((await short.view(c.operation_id)).reason).toBe('CONFIRMATION_EXPIRED');
      expect(await short.truth()).toMatchObject({ order_mutations: 0, carrier_mutations: 0 });
    } finally {
      await short.close();
    }
  });
});

describe('intent endpoint', () => {
  it('IN-06 interprets against the caller\'s own orders and addresses, with no side effects', async () => {
    const res = await s.app.inject({ method: 'POST', url: '/v1/intents/interpret', headers: { authorization: `Bearer mock_session_${target.customer_id}` }, payload: { message: `please move ${target.order_id} to ${target.to_address_id}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind: 'proposal', order_id: target.order_id, new_address_id: target.to_address_id });
    const theirs = await s.app.inject({ method: 'POST', url: '/v1/intents/interpret', headers: { authorization: `Bearer mock_session_${target.customer_id}` }, payload: { message: `move ${othersOrder.id} to the office` } });
    expect(theirs.json()).toEqual({ kind: 'refusal', reason: 'ORDER_NOT_FOUND' });
    expect((await s.pool.query('SELECT count(*)::int AS n FROM ledger.operations')).rows[0].n).toBe(0);
    await noSideEffects();
  });
});
