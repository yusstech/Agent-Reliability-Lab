// Generic mock provider: read, address-change and status-query endpoints with fault
// hooks (ADR-0008). The order and carrier services are thin definitions on top.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { AddressChangeBodySchema, applyAddressChange, type EntityTable, findMutationByKey } from './address-change.ts';
import { FaultEngine, type FaultMode, type FaultRule, type ProviderKind } from './faults.ts';
import { createProviderApp, parseInput, ProviderError } from './http.ts';
import { IDEMPOTENCY_KEY } from './ids.ts';

export interface ProviderDefinition<Row extends { address_id: string; version: number }> {
  kind: ProviderKind;
  name: string;
  /** e.g. "/orders"; the entity id is the next path segment. */
  prefix: string;
  /** Response property holding the entity, e.g. "order". */
  entityName: string;
  idPattern: RegExp;
  entity: EntityTable<Row>;
  /** If set, every request must carry this header and may only see rows it returns true for. */
  actor?: { header: string; pattern: RegExp; ownerColumn: string; canSee: (row: Row, actor: string) => boolean };
  /** World change applied by CONCURRENT_STATUS_CHANGE (not a client mutation). */
  concurrentStatusChange: (pool: pg.Pool, entityId: string) => Promise<void>;
}

export interface ProviderOptions {
  pool: pg.Pool;
  devRoutes?: boolean;
}

const pick = (rules: FaultRule[], fault: FaultMode) => rules.find((r) => r.fault === fault);
const unavailable = () => new ProviderError(503, 'SERVICE_UNAVAILABLE', 'service temporarily unavailable');

export function buildProvider<Row extends { address_id: string; version: number }>(
  def: ProviderDefinition<Row>,
  { pool, devRoutes = false }: ProviderOptions,
): { app: FastifyInstance; engine: FaultEngine<Row> } {
  const engine = new FaultEngine<Row>(def.kind);
  const { app, failTransport } = createProviderApp(def.name, engine as FaultEngine<unknown>, devRoutes);
  const IdParams = z.strictObject({ id: z.string().regex(def.idPattern) });
  const KeyParams = IdParams.extend({ key: z.string().regex(IDEMPOTENCY_KEY) });

  function actorOf(request: FastifyRequest): string | null {
    if (!def.actor) return null;
    const value = request.headers[def.actor.header];
    if (typeof value !== 'string' || !def.actor.pattern.test(value)) {
      throw new ProviderError(400, 'MISSING_ACTING_CUSTOMER', `${def.actor.header} header is required`);
    }
    return value;
  }
  const visible = (actor: string | null) => (row: Row) => actor === null || def.actor!.canSee(row, actor);

  // Every route resolves the entity first, so faults only ever act on requests the caller
  // was entitled to make: a missing or not-owned entity is a plain 404 and consumes no
  // fault budget.
  async function load(id: string, actor: string | null): Promise<Row> {
    const { rows } = await pool.query<Row>(`SELECT ${def.entity.columns} FROM ${def.entity.table} WHERE ${def.entity.keyColumn} = $1`, [id]);
    const row = rows[0];
    if (!row || !visible(actor)(row)) throw new ProviderError(404, 'NOT_FOUND', `${def.entityName} not found`);
    return row;
  }

  if (def.actor) {
    // The acting customer's own entities (used by the rule-based intent layer). No fault
    // hooks: listing is not part of the write path under study.
    const { ownerColumn } = def.actor;
    app.get(def.prefix, async (request) => {
      const actor = actorOf(request) as string;
      const { rows } = await pool.query<Row>(
        `SELECT ${def.entity.columns} FROM ${def.entity.table} WHERE ${ownerColumn} = $1 ORDER BY ${def.entity.keyColumn}`,
        [actor],
      );
      return { [`${def.entityName}s`]: rows };
    });
  }

  app.get(`${def.prefix}/:id`, async (request, reply) => {
    const { id } = parseInput(IdParams, request.params);
    const actor = actorOf(request);
    const current = await load(id, actor);
    const rules = engine.fire('read', id);
    const timeout = pick(rules, 'TIMEOUT_BEFORE_WRITE');
    if (timeout) return failTransport(request, reply, timeout);
    if (pick(rules, 'UNAVAILABLE_STATUS_QUERY')) throw unavailable();

    const served = engine.takeStale(id) ?? current;
    // The caller has now "validated" the entity; the world moves on behind it.
    if (pick(rules, 'CONCURRENT_STATUS_CHANGE')) await def.concurrentStatusChange(pool, id);
    return { [def.entityName]: served };
  });

  app.post(`${def.prefix}/:id/address-changes`, async (request, reply) => {
    const { id } = parseInput(IdParams, request.params);
    const actor = actorOf(request);
    const body = parseInput(AddressChangeBodySchema, request.body);
    await load(id, actor);
    const rules = engine.fire('mutation', id);

    if (pick(rules, 'PERMANENT_REJECTION')) throw new ProviderError(422, 'PROVIDER_REJECTED', 'provider rejected the change');
    const before = pick(rules, 'TIMEOUT_BEFORE_WRITE');
    if (before) return failTransport(request, reply, before);
    if (pick(rules, 'CONCURRENT_STATUS_CHANGE')) await def.concurrentStatusChange(pool, id);

    const honour = engine.honoursIdempotencyKeys;
    const result = await applyAddressChange(pool, def.entity, id, body, honour, visible(actor));
    if (pick(rules, 'DUPLICATE_DELIVERY')) {
      // The same request arrives again in transit. Its response goes nowhere; only its
      // side effect (or refusal) on the store matters.
      await applyAddressChange(pool, def.entity, id, body, honour, visible(actor)).catch((err: unknown) => {
        if (!(err instanceof ProviderError)) throw err;
      });
    }
    const after = pick(rules, 'TIMEOUT_AFTER_WRITE');
    if (after) return failTransport(request, reply, after);
    const slow = pick(rules, 'SLOW_CONSISTENCY');
    if (slow && !result.replayed) engine.markStale(id, result.before, slow.params.stale_reads);

    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return { mutation: result.mutation, [def.entityName]: result.entity };
  });

  app.get(`${def.prefix}/:id/address-changes/:key`, async (request, reply) => {
    const { id, key } = parseInput(KeyParams, request.params);
    const actor = actorOf(request);
    await load(id, actor);
    const rules = engine.fire('status_query', id);
    const timeout = pick(rules, 'TIMEOUT_BEFORE_WRITE');
    if (timeout) return failTransport(request, reply, timeout);
    if (pick(rules, 'UNAVAILABLE_STATUS_QUERY')) throw unavailable();
    if (!engine.honoursIdempotencyKeys) {
      throw new ProviderError(501, 'NOT_SUPPORTED', 'this provider does not support lookup by idempotency key');
    }
    const mutation = await findMutationByKey(pool, def.entity as EntityTable<unknown>, id, key);
    if (!mutation) throw new ProviderError(404, 'MUTATION_NOT_FOUND', 'no mutation was applied with this key');
    return { applied: true, mutation };
  });

  return { app, engine };
}
