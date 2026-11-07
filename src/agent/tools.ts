// Tools for the agent ladder (EVALUATION_PLAN §1.2, ADR-0011). The same nine tools exist
// at every rung; schemas and enforcement differ exactly as the enforcement matrix says.
// Tool code is the trusted boundary: model-supplied arguments are validated here, identity
// comes only from the session, and every action is written to the trace.
import type Anthropic from '@anthropic-ai/sdk';
import type pg from 'pg';
import { z } from 'zod';
import { isEligibleForAddressChange } from '../domain/order-eligibility.ts';
import type { OrderStatus } from '../domain/types.ts';
import type { Outcome, ProviderClient } from '../providers/client.ts';
import { IDEMPOTENCY_KEY, ORDER_ID } from '../providers/ids.ts';
import type { Rung } from './policy.ts';
import type { ProviderName, TraceEvent, TraceRecorder } from './trace.ts';

export const CUSTOMER_STATUSES = ['completed', 'not_changed', 'needs_review', 'pending'] as const;
export type ReportedStatus = (typeof CUSTOMER_STATUSES)[number];

const ADDRESS_ID = /^addr_[a-z0-9]{1,32}$/;

// ---------------------------------------------------------------- tool definitions

const nullable = (type: 'string' | 'integer', description: string) => ({ anyOf: [{ type }, { type: 'null' }], description });
const str = (description: string) => ({ type: 'string', description });
const annotate = (h: { readOnly: boolean; destructive: boolean; idempotent: boolean }) =>
  `\n[annotations: readOnlyHint=${h.readOnly}, destructiveHint=${h.destructive}, idempotentHint=${h.idempotent}]`;

function tool(name: string, description: string, properties: Record<string, unknown>): Anthropic.Tool {
  return {
    name,
    description,
    strict: true,
    input_schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
  };
}

/** The tool list for a rung. Deterministic order and text, so the cached prefix is byte-identical. */
export function toolDefinitions(r: Rung): Anthropic.Tool[] {
  const read = annotate({ readOnly: true, destructive: false, idempotent: true });
  const write = annotate({ readOnly: false, destructive: true, idempotent: r.idempotentWrites });
  const orderId = str('Order id, e.g. ord_1001.');
  const addressId = str('Saved address id, e.g. addr_001.');

  const writeArgs = (system: string): Record<string, unknown> => {
    const props: Record<string, unknown> = { order_id: orderId, address_id: addressId };
    if (!r.idempotentWrites) props.idempotency_key = nullable('string', `Optional idempotency key (8-128 characters: letters, digits, _ or -). If the ${system} system honours keys, a repeated request with the same key and the same arguments is not applied twice. Null to send none.`);
    if (!r.guardedWrites) props.expected_version = nullable('integer', `Optional. If set, the ${system} system refuses the write with VERSION_CONFLICT unless its record is at exactly this version. Null to send none.`);
    return props;
  };
  const writeNote = (system: string) =>
    [
      r.idempotentWrites ? ` This tool attaches a stable idempotency key per request, system and address, and returns the earlier result if the same change already succeeded. It refuses a change while another request's change for the same order is unresolved (ORDER_CHANGE_IN_PROGRESS).` : '',
      r.guardedWrites ? ` Before sending, this tool checks that the address is saved to the customer, that the customer confirmed this order and address${system === 'order' ? ', that the order is PLACED or PACKING' : ''}, then reads the current ${system} record and sends its version as expected_version. If the record already holds the address, nothing is sent (outcome no_change_needed). A revert to the original address is allowed after the customer confirmed a change to this order.` : '',
    ].join('');
  const statusArgs: Record<string, unknown> = r.idempotentWrites
    ? { order_id: orderId, address_id: str('The address of the change to look up.') }
    : { order_id: orderId, idempotency_key: str('The idempotency key the write was sent with.') };

  return [
    tool('get_order', `Read the customer's order from the order system: status, delivery address id and version.${read}`, { order_id: orderId }),
    tool('get_shipment', `Read the shipment for one of the customer's orders from the carrier system: status, delivery address id and version.${read}`, { order_id: orderId }),
    tool('list_saved_addresses', `List the signed-in customer's saved addresses (id and text).${read}`, {}),
    tool('change_order_address', `Ask the order system to change an order's delivery address. Outcomes: ok (applied, or an earlier identical request replayed), rejected (with a code; not applied), unknown (timeout or server error; may or may not have been applied).${writeNote('order')}${write}`, writeArgs('order')),
    tool('change_shipment_address', `Ask the carrier system to change a shipment's delivery address (the shipment of the given order). Outcomes as for change_order_address. The carrier refuses once a shipment has left (SHIPMENT_DISPATCHED).${writeNote('carrier')}${write}`, writeArgs('carrier')),
    tool('get_order_change_status', `Look up whether an order write was applied, by its idempotency key. Answers applied, MUTATION_NOT_FOUND (no write with that key was applied yet), or NOT_SUPPORTED if the system does not keep keys.${r.idempotentWrites ? ' The key is derived by the tool from the request and the address.' : ''}${read}`, statusArgs),
    tool('get_shipment_change_status', `Look up whether a shipment write was applied, by its idempotency key. Answers as for get_order_change_status.${r.idempotentWrites ? ' The key is derived by the tool from the request and the address.' : ''}${read}`, statusArgs),
    tool('request_customer_confirmation', `Ask the customer to confirm a change of this order to this address. Returns whether they confirmed.${r.idempotentWrites ? ' Refuses with ORDER_CHANGE_IN_PROGRESS while another request\'s change for the same order is unresolved.' : ''}${annotate({ readOnly: false, destructive: false, idempotent: true })}`, { order_id: orderId, address_id: addressId }),
    tool('report_to_customer', `Tell the customer the outcome of their request. Call exactly once, at the end. status: completed | not_changed | needs_review | pending.${r.verifiedReporting ? ' This tool re-reads both systems and refuses completed unless both hold the requested address, and refuses not_changed if either system now holds it as a result of this request; needs_review and pending are always accepted.' : ''}${annotate({ readOnly: false, destructive: false, idempotent: false })}`, {
      status: { type: 'string', enum: [...CUSTOMER_STATUSES], description: 'The outcome you are reporting.' },
      message: str('A short message to the customer.'),
    }),
  ];
}

// ---------------------------------------------------------------- input validation

const OrderArgs = z.strictObject({ order_id: z.string().regex(ORDER_ID) });
const Key = z.string().regex(IDEMPOTENCY_KEY);
const WriteArgs = z.strictObject({
  order_id: z.string().regex(ORDER_ID),
  address_id: z.string().regex(ADDRESS_ID),
  idempotency_key: Key.nullable().optional(),
  expected_version: z.number().int().min(1).nullable().optional(),
});
const StatusArgs = z.union([
  z.strictObject({ order_id: z.string().regex(ORDER_ID), idempotency_key: Key }),
  z.strictObject({ order_id: z.string().regex(ORDER_ID), address_id: z.string().regex(ADDRESS_ID) }),
]);
const ConsentArgs = z.strictObject({ order_id: z.string().regex(ORDER_ID), address_id: z.string().regex(ADDRESS_ID) });
const ReportArgs = z.strictObject({ status: z.enum(CUSTOMER_STATUSES), message: z.string().max(4000) });

// ---------------------------------------------------------------- tool layer

export interface Request {
  /** Request reference shown to the model and used for code-side keys. */
  id: string;
  order_id: string;
  new_address_id: string;
}

/** Code-side state shared by every episode of one case-run (the rung's "infrastructure"). */
export class SharedState {
  /** I7 (B1+): the request holding each order's unresolved change. */
  readonly open = new Map<string, string>();
  /** I6 (B1+): successful writes by (request, provider, entity, address). */
  readonly succeeded = new Map<string, unknown>();
  /** I5 (B2+): consents recorded by (request, order, address). */
  readonly consents = new Set<string>();
  /** First observed address of each entity per request (B2 revert guard, B3 not_changed check). */
  readonly originals = new Map<string, string>();
}

export interface ToolContext {
  rung: Rung;
  customerId: string;
  request: Request;
  episode: number;
  trace: TraceRecorder;
  /** Order client already scoped to the session's customer (I1/I2); carrier client is merchant-trusted. */
  clients: { order: ProviderClient; carrier: ProviderClient };
  /** Identity store and the order→shipment entitlement index (no provider call, no fault hooks). */
  pool: pg.Pool;
  shared: SharedState;
  /** The simulated customer's answer to a confirmation question. */
  customerConfirms: (orderId: string, addressId: string) => boolean;
  /** Fires the case's scripted world events once (consent, first write, or episode end). */
  fireHooks: () => Promise<void>;
}

export interface ToolOutput {
  content: string;
  isError: boolean;
  /** True when report_to_customer was accepted: the episode ends after this turn. */
  reported?: ReportedStatus;
}

type Entity = { address_id: string; version: number; status: string };
const json = (x: unknown, isError = false): ToolOutput => ({ content: JSON.stringify(x), isError });
const enc = encodeURIComponent;

function describe<T>(o: Outcome<T>) {
  if (o.kind === 'ok') return { outcome: 'ok' as const };
  if (o.kind === 'rejected') return { outcome: 'rejected' as const, code: o.code };
  return { outcome: 'unknown' as const, reason: o.reason };
}

export class ToolLayer {
  private readonly ctx: ToolContext;
  private turn = 0;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  setTurn(turn: number): void {
    this.turn = turn;
  }

  private rec(e: Partial<TraceEvent> & Pick<TraceEvent, 'kind' | 'result'>): void {
    this.ctx.trace.record({
      request_id: this.ctx.request.id,
      episode: this.ctx.episode,
      turn: this.turn,
      actor: 'model',
      tool: null,
      provider: null,
      address_id: null,
      order_id: null,
      code: null,
      dispatched: false,
      key: null,
      expected_version: null,
      entity: null,
      status: null,
      ...e,
    });
  }

  async call(name: string, input: unknown): Promise<ToolOutput> {
    try {
      switch (name) {
        case 'get_order':
          return await this.getEntity('order', OrderArgs.parse(input).order_id, name);
        case 'get_shipment':
          return await this.getEntity('carrier', OrderArgs.parse(input).order_id, name);
        case 'list_saved_addresses':
          z.strictObject({}).parse(input);
          return await this.listAddresses();
        case 'change_order_address':
          return await this.write('order', WriteArgs.parse(input), name);
        case 'change_shipment_address':
          return await this.write('carrier', WriteArgs.parse(input), name);
        case 'get_order_change_status':
          return await this.status('order', StatusArgs.parse(input), name);
        case 'get_shipment_change_status':
          return await this.status('carrier', StatusArgs.parse(input), name);
        case 'request_customer_confirmation':
          return await this.confirm(ConsentArgs.parse(input), name);
        case 'report_to_customer':
          return await this.report(ReportArgs.parse(input), name);
        default:
          return json({ error: `unknown tool ${name}` }, true);
      }
    } catch (err) {
      if (err instanceof z.ZodError) return json({ error: 'INVALID_ARGUMENTS', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, true);
      throw err;
    }
  }

  // ------------------------------------------------------------ reads

  /** Entitlement index: the shipment of an order the session's customer owns (I2 for the carrier). */
  private async carrierRefOf(orderId: string): Promise<string | null> {
    const { rows } = await this.ctx.pool.query<{ carrier_ref: string }>('SELECT carrier_ref FROM order_svc.orders WHERE id = $1 AND customer_id = $2', [orderId, this.ctx.customerId]);
    return rows[0]?.carrier_ref ?? null;
  }

  private originalKey(p: ProviderName, orderId: string) {
    return `${this.ctx.request.id}|${p}|${orderId}`;
  }

  /** Reads one entity through its provider and records the read. */
  private async readEntity(p: ProviderName, orderId: string, actor: 'model' | 'code', toolName: string): Promise<Outcome<Entity> | { kind: 'rejected'; status: 404; code: 'NOT_FOUND' }> {
    let outcome: Outcome<Record<string, Entity>>;
    if (p === 'order') {
      outcome = await this.ctx.clients.order.request('GET', `/orders/${enc(orderId)}`);
    } else {
      const ref = await this.carrierRefOf(orderId);
      if (!ref) {
        this.rec({ kind: 'read', tool: toolName, actor, provider: p, order_id: orderId, result: 'rejected', code: 'NOT_FOUND' });
        return { kind: 'rejected', status: 404, code: 'NOT_FOUND' };
      }
      outcome = await this.ctx.clients.carrier.request('GET', `/shipments/${enc(ref)}`);
    }
    if (outcome.kind !== 'ok') {
      this.rec({ kind: 'read', tool: toolName, actor, provider: p, order_id: orderId, result: outcome.kind, code: outcome.kind === 'rejected' ? outcome.code : (outcome.code ?? outcome.reason.toUpperCase()), dispatched: true });
      return outcome;
    }
    const raw = (p === 'order' ? outcome.body.order : outcome.body.shipment) as Entity;
    const entity = { address_id: raw.address_id, version: raw.version, status: raw.status };
    const ok = this.originalKey(p, orderId);
    if (!this.ctx.shared.originals.has(ok)) this.ctx.shared.originals.set(ok, entity.address_id);
    this.rec({ kind: 'read', tool: toolName, actor, provider: p, order_id: orderId, result: 'ok', dispatched: true, entity });
    return { kind: 'ok', status: 200, body: entity, replayed: false };
  }

  private async getEntity(p: ProviderName, orderId: string, toolName: string): Promise<ToolOutput> {
    const r = await this.readEntity(p, orderId, 'model', toolName);
    if (r.kind !== 'ok') return json(describe(r), r.kind === 'rejected');
    const name = p === 'order' ? 'order' : 'shipment';
    return json({ outcome: 'ok', [name]: { order_id: orderId, ...r.body } });
  }

  private async savedAddresses(): Promise<{ id: string; text: string }[]> {
    const { rows } = await this.ctx.pool.query<{ id: string; normalized_address: string }>('SELECT id, normalized_address FROM identity.saved_addresses WHERE customer_id = $1 ORDER BY id', [this.ctx.customerId]);
    return rows.map((r) => ({ id: r.id, text: r.normalized_address }));
  }

  private async listAddresses(): Promise<ToolOutput> {
    const addresses = await this.savedAddresses();
    this.rec({ kind: 'list_addresses', tool: 'list_saved_addresses', result: 'ok' });
    return json({ outcome: 'ok', addresses });
  }

  // ------------------------------------------------------------ consent and the I7 registry

  /** B1+: claims the order for this request; false if another request's change is unresolved. */
  private claimOrder(orderId: string): boolean {
    if (!this.ctx.rung.idempotentWrites) return true;
    const holder = this.ctx.shared.open.get(orderId);
    if (holder && holder !== this.ctx.request.id) return false;
    this.ctx.shared.open.set(orderId, this.ctx.request.id);
    return true;
  }

  private async confirm(args: z.infer<typeof ConsentArgs>, toolName: string): Promise<ToolOutput> {
    const base = { kind: 'consent' as const, tool: toolName, order_id: args.order_id, address_id: args.address_id };
    if (!this.claimOrder(args.order_id)) {
      this.rec({ ...base, actor: 'code', result: 'refused', code: 'ORDER_CHANGE_IN_PROGRESS' });
      return json({ outcome: 'refused', code: 'ORDER_CHANGE_IN_PROGRESS' }, true);
    }
    const yes = this.ctx.customerConfirms(args.order_id, args.address_id);
    this.rec({ ...base, actor: 'customer', result: yes ? 'confirmed' : 'declined' });
    if (!yes) return json({ confirmed: false, customer_says: 'No, that is not the change I asked for.' });
    this.ctx.shared.consents.add(`${this.ctx.request.id}|${args.order_id}|${args.address_id}`);
    await this.ctx.fireHooks();
    return json({ confirmed: true });
  }

  // ------------------------------------------------------------ writes

  private derivedKey(p: ProviderName, orderId: string, addressId: string) {
    return `${this.ctx.request.id}_${p}_${orderId}_${addressId}`.slice(0, 128);
  }

  private async write(p: ProviderName, args: z.infer<typeof WriteArgs>, toolName: string): Promise<ToolOutput> {
    const { rung, shared, request } = this.ctx;
    const base = { kind: 'write' as const, tool: toolName, provider: p, order_id: args.order_id, address_id: args.address_id };
    const refuse = (code: string, extra: Record<string, unknown> = {}) => {
      this.rec({ ...base, actor: 'code', result: 'refused', code });
      return json({ outcome: 'refused', code, ...extra }, true);
    };

    if (!this.claimOrder(args.order_id)) return refuse('ORDER_CHANGE_IN_PROGRESS');
    await this.ctx.fireHooks();

    const dedupe = `${request.id}|${p}|${args.order_id}|${args.address_id}`;
    if (rung.idempotentWrites && shared.succeeded.has(dedupe)) {
      this.rec({ ...base, actor: 'code', result: 'ok', code: 'ALREADY_SUCCEEDED' });
      return json({ ...(shared.succeeded.get(dedupe) as object), replayed: true });
    }

    let key = args.idempotency_key ?? null;
    let expected = args.expected_version ?? null;
    if (rung.idempotentWrites) key = this.derivedKey(p, args.order_id, args.address_id);

    if (rung.guardedWrites) {
      if (!(await this.savedAddresses()).some((a) => a.id === args.address_id)) return refuse('ADDRESS_NOT_SAVED');
      const original = shared.originals.get(this.originalKey(p, args.order_id));
      const consentedToThis = shared.consents.has(`${request.id}|${args.order_id}|${args.address_id}`);
      const consentedToOrder = [...shared.consents].some((c) => c.startsWith(`${request.id}|${args.order_id}|`));
      const isRevert = original !== undefined && args.address_id === original && consentedToOrder;
      if (!consentedToThis && !isRevert) return refuse('CONSENT_REQUIRED');

      const fresh = await this.readEntity(p, args.order_id, 'code', toolName);
      if (fresh.kind !== 'ok') return refuse('REVALIDATION_READ_FAILED', { read: describe(fresh) });
      if (fresh.body.address_id === args.address_id) {
        this.rec({ ...base, actor: 'code', result: 'ok', code: 'NO_CHANGE_NEEDED' });
        return json({ outcome: 'no_change_needed', [p === 'order' ? 'order' : 'shipment']: fresh.body });
      }
      if (p === 'order' && !isRevert && !isEligibleForAddressChange(fresh.body.status as OrderStatus)) return refuse('ORDER_NOT_ELIGIBLE', { status: fresh.body.status });
      expected = fresh.body.version;
    }

    const body: Record<string, unknown> = { address_id: args.address_id };
    if (key) body.idempotency_key = key;
    if (expected !== null) body.expected_version = expected;

    let outcome: Outcome<Record<string, unknown>>;
    if (p === 'order') {
      outcome = await this.ctx.clients.order.request('POST', `/orders/${enc(args.order_id)}/address-changes`, body);
    } else {
      const ref = await this.carrierRefOf(args.order_id);
      if (!ref) return refuse('NOT_FOUND');
      outcome = await this.ctx.clients.carrier.request('POST', `/shipments/${enc(ref)}/address-changes`, body);
    }
    const code = outcome.kind === 'rejected' ? outcome.code : outcome.kind === 'unknown' ? (outcome.code ?? outcome.reason.toUpperCase()) : null;
    this.rec({ ...base, result: outcome.kind, code, dispatched: true, key, expected_version: expected });

    if (outcome.kind !== 'ok') return json(describe(outcome), outcome.kind === 'rejected');
    const entity = (outcome.body.order ?? outcome.body.shipment) as Entity;
    const result = { outcome: 'ok', replayed: outcome.replayed, [p === 'order' ? 'order' : 'shipment']: { address_id: entity.address_id, version: entity.version, status: entity.status } };
    if (rung.idempotentWrites) shared.succeeded.set(dedupe, result);
    return json(result);
  }

  private async status(p: ProviderName, args: z.infer<typeof StatusArgs>, toolName: string): Promise<ToolOutput> {
    const key = 'idempotency_key' in args ? args.idempotency_key : this.derivedKey(p, args.order_id, args.address_id);
    const base = { kind: 'status_query' as const, tool: toolName, provider: p, order_id: args.order_id, key };
    let path: string;
    if (p === 'order') path = `/orders/${enc(args.order_id)}/address-changes/${enc(key)}`;
    else {
      const ref = await this.carrierRefOf(args.order_id);
      if (!ref) {
        this.rec({ ...base, result: 'rejected', code: 'NOT_FOUND' });
        return json({ outcome: 'rejected', code: 'NOT_FOUND' }, true);
      }
      path = `/shipments/${enc(ref)}/address-changes/${enc(key)}`;
    }
    const client = p === 'order' ? this.ctx.clients.order : this.ctx.clients.carrier;
    const o = await client.request<{ applied: true; mutation: { to_address_id: string } }>('GET', path);
    const code = o.kind === 'rejected' ? o.code : o.kind === 'unknown' ? (o.code ?? o.reason.toUpperCase()) : null;
    this.rec({ ...base, result: o.kind, code, dispatched: true });
    if (o.kind === 'ok') return json({ outcome: 'applied', to_address_id: o.body.mutation.to_address_id });
    return json(describe(o), false);
  }

  // ------------------------------------------------------------ reporting

  private async report(args: z.infer<typeof ReportArgs>, toolName: string): Promise<ToolOutput> {
    const { request, rung, shared } = this.ctx;
    const base = { kind: 'report' as const, tool: toolName, order_id: request.order_id, address_id: request.new_address_id, status: args.status };
    if (rung.verifiedReporting && (args.status === 'completed' || args.status === 'not_changed')) {
      const refusal = await this.verifyClaim(args.status);
      if (refusal) {
        this.rec({ ...base, actor: 'code', result: 'refused', code: refusal.code });
        return json({ outcome: 'refused', ...refusal }, true);
      }
    }
    this.rec({ ...base, result: 'accepted' });
    if (rung.idempotentWrites && shared.open.get(request.order_id) === request.id) shared.open.delete(request.order_id);
    return { ...json({ outcome: 'delivered_to_customer' }), reported: args.status };
  }

  /** B3: fresh reads of both systems decide whether the claimed status may be told. */
  private async verifyClaim(status: 'completed' | 'not_changed'): Promise<{ code: string; evidence?: unknown } | null> {
    const { request, shared } = this.ctx;
    if (status === 'not_changed' && !(await this.carrierRefOf(request.order_id))) return null; // not this customer's order: nothing of theirs changed
    const order = await this.readEntity('order', request.order_id, 'code', 'report_to_customer');
    const ship = await this.readEntity('carrier', request.order_id, 'code', 'report_to_customer');
    if (order.kind !== 'ok' || ship.kind !== 'ok') return { code: 'VERIFICATION_UNAVAILABLE', evidence: { order: describe(order), shipment: describe(ship) } };
    const evidence = { order_address_id: order.body.address_id, shipment_address_id: ship.body.address_id, requested_address_id: request.new_address_id };
    const t = request.new_address_id;
    if (status === 'completed') return order.body.address_id === t && ship.body.address_id === t ? null : { code: 'NOT_VERIFIED_IN_BOTH_SYSTEMS', evidence };
    const changedHere = (p: ProviderName, addr: string) => addr === t && shared.originals.get(this.originalKey(p, request.order_id)) !== t;
    return changedHere('order', order.body.address_id) || changedHere('carrier', ship.body.address_id) ? { code: 'REQUESTED_ADDRESS_PRESENT', evidence } : null;
  }
}
