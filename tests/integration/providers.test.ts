import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { generateFixture } from '../../fixtures/generate.ts';
import { seed } from '../../src/db/seed.ts';
import { ProviderClient } from '../../src/providers/client.ts';
import { buildOrderService } from '../../src/providers/order-service.ts';
import { pickTarget } from '../../src/providers/trace.ts';
import { createTestPool } from '../helpers/db.ts';
import { startTestProviders } from '../helpers/providers.ts';

const fixture = generateFixture();
const t = pickTarget(fixture);
const shipped = fixture.orders.find((o) => o.status === 'SHIPPED')!;
const otherCustomersOrder = fixture.orders.find((o) => o.customer_id !== t.customer_id)!;

const observer: pg.Pool = createTestPool();
let p: Awaited<ReturnType<typeof startTestProviders>>;
let order: ProviderClient;
let carrier: ProviderClient;
let admin: { order: ProviderClient; carrier: ProviderClient };

beforeAll(async () => {
  p = await startTestProviders();
  order = new ProviderClient({ baseUrl: p.orderUrl, timeoutMs: 200, headers: { 'x-acting-customer-id': t.customer_id } });
  carrier = new ProviderClient({ baseUrl: p.carrierUrl, timeoutMs: 200 });
  admin = { order: new ProviderClient({ baseUrl: p.orderUrl }), carrier: new ProviderClient({ baseUrl: p.carrierUrl }) };
});
afterAll(async () => {
  await p.close();
  await observer.end();
});
beforeEach(async () => {
  await seed(observer, fixture);
  await admin.order.request('DELETE', '/_dev/scenario');
  await admin.carrier.request('DELETE', '/_dev/scenario');
});

const pgCode = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
};
const counts = async () => ({
  order: (await observer.query('SELECT count(*)::int AS n FROM order_svc.address_mutations')).rows[0].n,
  carrier: (await observer.query('SELECT count(*)::int AS n FROM carrier_svc.address_mutations')).rows[0].n,
});
const change = (body: object = {}) => ({ address_id: t.to_address_id, idempotency_key: 'key_test_0001', ...body });

describe('provider isolation', () => {
  it('PV-01 each provider role can touch only its own schema', async () => {
    expect(await pgCode(() => p.orderPool.query(`UPDATE carrier_svc.shipments SET version = 9`))).toBe('42501');
    expect(await pgCode(() => p.orderPool.query(`SELECT 1 FROM carrier_svc.shipments`))).toBe('42501');
    expect(await pgCode(() => p.carrierPool.query(`UPDATE order_svc.orders SET version = 9`))).toBe('42501');
    expect(await pgCode(() => p.carrierPool.query(`SELECT 1 FROM identity.mock_sessions`))).toBe('42501');
    expect(await pgCode(() => p.orderPool.query(`SELECT 1 FROM ledger.operations`))).toBe('42501');
  });

  it('PV-02 the role is in force on every pooled connection, not just the first', async () => {
    const roles = await Promise.all(Array.from({ length: 5 }, () => p.orderPool.query<{ r: string }>('SELECT current_user AS r')));
    expect(new Set(roles.map((r) => r.rows[0]!.r))).toEqual(new Set(['arl_order_svc']));
  });

  it('PV-03 mutation logs are append-only for the services', async () => {
    expect(await pgCode(() => p.orderPool.query(`DELETE FROM order_svc.address_mutations`))).toBe('42501');
    expect(await pgCode(() => p.carrierPool.query(`UPDATE carrier_svc.address_mutations SET to_version = 1`))).toBe('42501');
  });

  it('PV-04 an order write leaves the carrier store untouched, and vice versa', async () => {
    const before = (await observer.query('SELECT * FROM carrier_svc.shipments ORDER BY carrier_ref')).rows;
    expect((await order.request('POST', `/orders/${t.order_id}/address-changes`, change())).kind).toBe('ok');
    expect((await observer.query('SELECT * FROM carrier_svc.shipments ORDER BY carrier_ref')).rows).toEqual(before);
    expect(await counts()).toEqual({ order: 1, carrier: 0 });
  });

  it('PV-05 scenario control routes do not exist unless enabled', async () => {
    const app = buildOrderService({ pool: p.orderPool }).app;
    const res = await app.inject({ method: 'PUT', url: '/_dev/scenario', payload: { scenario_id: 'x' } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('provider behaviour', () => {
  it('PB-01 the order service hides orders the acting customer does not own, and requires an actor', async () => {
    const res = await order.request('GET', `/orders/${otherCustomersOrder.id}`);
    expect(res).toMatchObject({ kind: 'rejected', status: 404, code: 'NOT_FOUND' });
    const write = await order.request('POST', `/orders/${otherCustomersOrder.id}/address-changes`, change());
    expect(write).toMatchObject({ kind: 'rejected', status: 404 });
    const anon = new ProviderClient({ baseUrl: p.orderUrl });
    expect(await anon.request('GET', `/orders/${t.order_id}`)).toMatchObject({ kind: 'rejected', status: 400, code: 'MISSING_ACTING_CUSTOMER' });
    expect(await counts()).toEqual({ order: 0, carrier: 0 });
  });

  it('PB-02 the order service does not enforce eligibility (I4 is application policy)', async () => {
    const owner = order.withHeaders({ 'x-acting-customer-id': shipped.customer_id });
    const alt = fixture.saved_addresses.find((a) => a.customer_id === shipped.customer_id && a.id !== shipped.address_id)!;
    expect((await owner.request('POST', `/orders/${shipped.id}/address-changes`, { address_id: alt.id })).kind).toBe('ok');
  });

  it('PB-03 the carrier refuses changes once a shipment is dispatched', async () => {
    const res = await carrier.request('POST', `/shipments/${shipped.carrier_ref}/address-changes`, { address_id: t.to_address_id });
    expect(res).toMatchObject({ kind: 'rejected', status: 422, code: 'SHIPMENT_DISPATCHED' });
  });

  it('PB-04 honoured keys replay without writing; a reused key with a different payload is refused', async () => {
    const first = await order.request('POST', `/orders/${t.order_id}/address-changes`, change());
    const again = await order.request('POST', `/orders/${t.order_id}/address-changes`, change());
    expect(first).toMatchObject({ kind: 'ok', replayed: false });
    expect(again).toMatchObject({ kind: 'ok', replayed: true });
    if (first.kind !== 'ok' || again.kind !== 'ok') throw new Error('expected both writes to succeed');
    expect((again.body as { mutation: unknown }).mutation).toEqual((first.body as { mutation: unknown }).mutation);
    const reused = await order.request('POST', `/orders/${t.order_id}/address-changes`, change({ address_id: t.from_address_id }));
    expect(reused).toMatchObject({ kind: 'rejected', status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await counts()).toEqual({ order: 1, carrier: 0 });
  });

  it('PB-05 ignored keys apply every time; expected_version still stops the second write', async () => {
    await admin.order.request('PUT', '/_dev/scenario', { scenario_id: 'no-keys', honour_idempotency_keys: false });
    await order.request('POST', `/orders/${t.order_id}/address-changes`, change());
    await order.request('POST', `/orders/${t.order_id}/address-changes`, change());
    expect(await counts()).toEqual({ order: 2, carrier: 0 });
    const stale = await order.request('POST', `/orders/${t.order_id}/address-changes`, change({ expected_version: 1 }));
    expect(stale).toMatchObject({ kind: 'rejected', status: 409, code: 'VERSION_CONFLICT' });
    expect(await counts()).toEqual({ order: 2, carrier: 0 });
  });

  it('PB-06 the status endpoint is authoritative when keys are honoured and unsupported otherwise', async () => {
    const path = `/orders/${t.order_id}/address-changes/key_test_0001`;
    expect(await order.request('GET', path)).toMatchObject({ kind: 'rejected', status: 404, code: 'MUTATION_NOT_FOUND' });
    await order.request('POST', `/orders/${t.order_id}/address-changes`, change());
    expect(await order.request('GET', path)).toMatchObject({ kind: 'ok', body: { applied: true } });
    await admin.order.request('PUT', '/_dev/scenario', { scenario_id: 'no-keys', honour_idempotency_keys: false });
    expect(await order.request('GET', path)).toMatchObject({ kind: 'rejected', status: 501, code: 'NOT_SUPPORTED' });
  });

  it('PB-07 invalid scenario configs are refused with field details', async () => {
    const res = await admin.order.request('PUT', '/_dev/scenario', { scenario_id: 's', rules: [{ fault: 'TIMEOUT_AFTER_WRITE', target: '*', on: 'read' }] });
    expect(res).toMatchObject({ kind: 'rejected', status: 400, code: 'VALIDATION_FAILED' });
  });
});

describe('fault distinctions (the property the study depends on)', () => {
  const timeoutRun = async (fault: 'TIMEOUT_BEFORE_WRITE' | 'TIMEOUT_AFTER_WRITE') => {
    await seed(observer, fixture);
    await admin.order.request('PUT', '/_dev/scenario', { scenario_id: fault, rules: [{ fault, target: '*', params: { hang_ms: 2000 } }] });
    const outcome = await order.request('POST', `/orders/${t.order_id}/address-changes`, change());
    const status = await order.request('GET', `/orders/${t.order_id}/address-changes/key_test_0001`);
    const row = (await observer.query('SELECT address_id, version FROM order_svc.orders WHERE id = $1', [t.order_id])).rows[0];
    return { outcome, status, row, counts: await counts() };
  };

  it('FD-01 timeout-before-write and timeout-after-write look identical to the caller and differ only in provider state', async () => {
    const before = await timeoutRun('TIMEOUT_BEFORE_WRITE');
    const after = await timeoutRun('TIMEOUT_AFTER_WRITE');
    expect(before.outcome).toEqual({ kind: 'unknown', reason: 'timeout' });
    expect(after.outcome).toEqual(before.outcome);
    expect(before.row).toEqual({ address_id: t.from_address_id, version: 1 });
    expect(after.row).toEqual({ address_id: t.to_address_id, version: 2 });
    expect(before.counts.order).toBe(0);
    expect(after.counts.order).toBe(1);
    expect(before.status).toMatchObject({ kind: 'rejected', code: 'MUTATION_NOT_FOUND' });
    expect(after.status).toMatchObject({ kind: 'ok', body: { applied: true } });
  });

  it('FD-02 a reset connection is unknown too, and distinguishable from a timeout only by reason', async () => {
    await admin.carrier.request('PUT', '/_dev/scenario', { scenario_id: 'r', rules: [{ fault: 'TIMEOUT_AFTER_WRITE', target: '*', params: { manifest: 'reset' } }] });
    const outcome = await carrier.request('POST', `/shipments/${t.carrier_ref}/address-changes`, change());
    expect(outcome).toEqual({ kind: 'unknown', reason: 'connection_error' });
    expect((await counts()).carrier).toBe(1);
  });

  it('FD-03 a 503 is unknown, never a rejection', async () => {
    await admin.order.request('PUT', '/_dev/scenario', { scenario_id: 'u', rules: [{ fault: 'UNAVAILABLE_STATUS_QUERY', target: '*', on: 'read' }] });
    expect(await order.request('GET', `/orders/${t.order_id}`)).toMatchObject({ kind: 'unknown', reason: 'server_error', status: 503 });
  });
});
