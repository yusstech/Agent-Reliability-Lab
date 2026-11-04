// The full variant A stack against the test database: API, both providers, a worker.
import { generateFixture } from '../../fixtures/generate.ts';
import { seed } from '../../src/db/seed.ts';
import type { ScenarioConfigInput } from '../../src/providers/faults.ts';
import { pickTarget } from '../../src/providers/trace.ts';
import { startVariantA } from '../../src/workflow/harness.ts';
import { testDatabaseUrl } from './db.ts';

export const fixture = generateFixture();
export const target = pickTarget(fixture);
export const tokenFor = (customerId: string) => `Bearer mock_session_${customerId}`;

export async function startStack({ clientTimeoutMs = 150, confirmationTtlMs }: { clientTimeoutMs?: number; confirmationTtlMs?: number } = {}) {
  const a = await startVariantA(testDatabaseUrl(), { clientTimeoutMs, requests: { confirmationTtlMs } });
  const { pool, app, admin } = a;

  return {
    ...a,
    async reset() {
      await seed(pool, fixture);
      await admin.order.request('DELETE', '/_dev/scenario');
      await admin.carrier.request('DELETE', '/_dev/scenario');
    },
    async faults(p: 'order' | 'carrier', config: Omit<ScenarioConfigInput, 'scenario_id'>) {
      const r = await admin[p].request('PUT', '/_dev/scenario', { scenario_id: 'test', ...config });
      if (r.kind !== 'ok') throw new Error(`could not load faults: ${JSON.stringify(r)}`);
    },
    submit(body: Record<string, unknown>, customerId = target.customer_id) {
      return app.inject({ method: 'POST', url: '/v1/address-change-requests', headers: { authorization: tokenFor(customerId) }, payload: body });
    },
    confirm(operationId: string, token: string, customerId = target.customer_id) {
      return app.inject({ method: 'POST', url: `/v1/operations/${operationId}/confirm`, headers: { authorization: tokenFor(customerId) }, payload: { confirmation_token: token } });
    },
    async view(operationId: string, customerId = target.customer_id) {
      return (await app.inject({ method: 'GET', url: `/v1/operations/${operationId}`, headers: { authorization: tokenFor(customerId) } })).json();
    },
    /** Submits and confirms a change of the default target; returns the operation id. */
    async confirmed(key = 'req_default_0001', body: Record<string, unknown> = {}) {
      const res = await this.submit({ order_id: target.order_id, new_address_id: target.to_address_id, idempotency_key: key, ...body });
      if (res.statusCode !== 202) throw new Error(`submit failed: ${res.statusCode} ${res.body}`);
      const created = res.json();
      const ok = await this.confirm(created.operation_id, created.confirmation.token);
      if (ok.statusCode !== 200) throw new Error(`confirm failed: ${ok.statusCode} ${ok.body}`);
      return created.operation_id as string;
    },
    /** Ground truth straight from both provider stores. */
    async truth() {
      const q = async (sql: string, p: unknown[]) => (await pool.query(sql, p)).rows;
      const [order] = await q('SELECT address_id, version, status FROM order_svc.orders WHERE id = $1', [target.order_id]);
      const [shipment] = await q('SELECT address_id, version, status FROM carrier_svc.shipments WHERE carrier_ref = $1', [target.carrier_ref]);
      const [counts] = await q(
        `SELECT (SELECT count(*)::int FROM order_svc.address_mutations) AS order_mutations,
                (SELECT count(*)::int FROM carrier_svc.address_mutations) AS carrier_mutations`,
        [],
      );
      return { order, shipment, ...counts };
    },
    async events(operationId: string) {
      return (await pool.query('SELECT step, from_status, to_status, reason_code, result, error_code FROM ledger.operation_events WHERE operation_id = $1 ORDER BY sequence', [operationId])).rows;
    },
  };
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
