// Variant A's durable worker (ADR-0009). One claimed step = at most one provider write,
// logged before dispatch, with every ledger write fenced by the lease token.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { OperationStatus } from '../domain/operation-state.ts';
import { isEligibleForAddressChange } from '../domain/order-eligibility.ts';
import type { Outcome } from '../providers/client.ts';
import type { Providers } from './adapters.ts';
import {
  appendEvent,
  applyTransition,
  claimNext,
  type EventInput,
  type EventRow,
  fenced,
  listEvents,
  type OperationRow,
  releaseLease,
  type TransitionEvidence,
} from './ledger.ts';
import { readBothSystems } from './verifier.ts';

/** Points where a test can simulate the process dying (no lease release, no result). */
export type CrashPoint = 'after_dispatch_logged' | 'after_provider_write';

export class SimulatedCrash extends Error {
  constructor(point: CrashPoint) {
    super(`simulated crash at ${point}`);
    this.name = 'SimulatedCrash';
  }
}

export interface WorkerOptions {
  pool: pg.Pool;
  providers: Providers;
  leaseMs?: number;
  /** Retries per state before escalating to NEEDS_MANUAL_REVIEW. */
  maxStepAttempts?: number;
  /** Delay before retry n (1-based). */
  backoffMs?: (attempt: number) => number;
  /** Test hook: return true to crash at this point. May be async (e.g. to perturb the DB first). */
  crashAt?: (point: CrashPoint, op: OperationRow) => boolean | Promise<boolean>;
}

type Provider = 'order' | 'carrier';
const WRITE_DISPATCHED: Record<Provider, string> = { order: 'ORDER_WRITE_DISPATCHED', carrier: 'CARRIER_WRITE_DISPATCHED' };

interface DispatchDetail {
  provider: Provider;
  key: string;
  expected_version: number;
}

/** What the step decided; applied by the worker in one fenced transaction. */
type Decision =
  | { kind: 'transition'; to: OperationStatus; reason: string; evidence?: TransitionEvidence; events?: EventInput[] }
  | { kind: 'retry'; reason: string; events?: EventInput[] }
  | { kind: 'continue'; reason: string; events?: EventInput[] };

const transition = (to: OperationStatus, reason: string, extra: Omit<Extract<Decision, { kind: 'transition' }>, 'kind' | 'to' | 'reason'> = {}): Decision => ({ kind: 'transition', to, reason, ...extra });
const retry = (reason: string, events?: EventInput[]): Decision => ({ kind: 'retry', reason, events });
const escalate = (reason: string, events?: EventInput[]): Decision => transition('NEEDS_MANUAL_REVIEW', reason, { events });

function outcomeEvent(step: string, outcome: Outcome<unknown>, extra: Partial<EventInput> = {}): EventInput {
  return {
    step,
    reason_code: outcome.kind === 'ok' ? 'PROVIDER_OK' : outcome.kind === 'rejected' ? 'PROVIDER_REJECTED' : 'OUTCOME_UNKNOWN',
    result: outcome.kind,
    error_code: outcome.kind === 'rejected' ? outcome.code : outcome.kind === 'unknown' ? (outcome.code ?? outcome.reason.toUpperCase()) : null,
    ...extra,
  };
}

export class Worker {
  private readonly pool: pg.Pool;
  private readonly providers: Providers;
  private readonly leaseMs: number;
  private readonly maxStepAttempts: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly crashAt: WorkerOptions['crashAt'];

  constructor(o: WorkerOptions) {
    this.pool = o.pool;
    this.providers = o.providers;
    this.leaseMs = o.leaseMs ?? 30_000;
    this.maxStepAttempts = o.maxStepAttempts ?? 5;
    this.backoffMs = o.backoffMs ?? ((n) => Math.min(100 * 2 ** n, 30_000));
    this.crashAt = o.crashAt;
  }

  /** Claims and runs one step. Returns false when nothing was claimable. */
  async runOnce(operationId: string | null = null): Promise<boolean> {
    const token = randomUUID();
    const op = await claimNext(this.pool, token, this.leaseMs, operationId);
    if (!op) return false;
    const events = await listEvents(this.pool, op.id);
    const decision = await this.step(op, events, token);
    await this.apply(op.id, token, decision);
    return true;
  }

  /** Runs steps until nothing is claimable (or maxSteps). Returns the number of steps run. */
  async runUntilIdle({ maxSteps = 500, operationId = null }: { maxSteps?: number; operationId?: string | null } = {}): Promise<number> {
    let steps = 0;
    while (steps < maxSteps && (await this.runOnce(operationId))) steps++;
    return steps;
  }

  private async apply(operationId: string, token: string, d: Decision): Promise<void> {
    await fenced(this.pool, operationId, token, async (client, op) => {
      for (const e of d.events ?? []) await appendEvent(client, op.id, e);
      if (d.kind === 'transition') {
        await applyTransition(client, op, d.to, d.reason, d.evidence);
        await releaseLease(client, op.id, null);
        return;
      }
      if (d.kind === 'continue') {
        await appendEvent(client, op.id, { step: 'CONTINUE', reason_code: d.reason });
        await releaseLease(client, op.id, null);
        return;
      }
      const attempt = op.step_attempts + 1;
      if (attempt >= this.maxStepAttempts) {
        await applyTransition(client, op, 'NEEDS_MANUAL_REVIEW', `${d.reason}_UNRESOLVED`.slice(0, 64), { detail: { attempts: attempt } });
        await releaseLease(client, op.id, null);
        return;
      }
      const delay = this.backoffMs(attempt);
      await client.query('UPDATE ledger.operations SET step_attempts = $2 WHERE id = $1', [op.id, attempt]);
      await appendEvent(client, op.id, { step: 'RETRY_SCHEDULED', reason_code: d.reason, detail: { attempt, delay_ms: delay } });
      await releaseLease(client, op.id, delay);
    });
  }

  private async crash(point: CrashPoint, op: OperationRow): Promise<void> {
    if (await this.crashAt?.(point, op)) throw new SimulatedCrash(point);
  }

  /** Commits the write-ahead dispatch record while still holding the lease. */
  private async logDispatch(op: OperationRow, token: string, step: string, detail: DispatchDetail & Record<string, unknown>): Promise<void> {
    await fenced(this.pool, op.id, token, (client) => appendEvent(client, op.id, { step, reason_code: 'WRITE_DISPATCHED', detail }));
    await this.crash('after_dispatch_logged', op);
  }

  private async step(op: OperationRow, events: EventRow[], token: string): Promise<Decision> {
    switch (op.status) {
      case 'NEEDS_CONFIRMATION':
        return transition('REJECTED', 'CONFIRMATION_EXPIRED');
      case 'QUEUED':
        return transition('UPDATING_ORDER', 'WORK_STARTED');
      case 'UPDATING_ORDER':
        return this.updateOrder(op, events, token);
      case 'UPDATING_CARRIER':
        return this.updateCarrier(op, events, token);
      case 'PENDING_RECONCILIATION':
        return this.reconcile(op, events);
      case 'VERIFYING':
        return this.verify(op);
      case 'COMPENSATING':
        return this.compensate(op, token);
      default:
        // Claimed a status that is not runnable (should be impossible given claimNext).
        return escalate('UNEXPECTED_STATUS');
    }
  }

  /**
   * True if an earlier write to this provider may have landed: it was dispatched and its
   * outcome was never shown to be "not applied" (a definitive rejection of that request,
   * or reconciliation finding no mutation for its key). Only then is REJECTED unsafe.
   */
  private possiblyApplied(events: EventRow[], provider: Provider): boolean {
    const open = new Set<string>();
    for (const e of events) {
      const key = (e.detail as { key?: string } | null)?.key;
      if (!key) continue;
      if (e.step === WRITE_DISPATCHED[provider]) open.add(key);
      const refused = (e.step === 'ORDER_WRITE_RESULT' || e.step === 'CARRIER_WRITE_RESULT') && e.result === 'rejected';
      const notFound = e.step === 'RECONCILE_STATUS_QUERY' && e.error_code === 'MUTATION_NOT_FOUND';
      if (refused || notFound) open.delete(key);
    }
    return open.size > 0;
  }

  private async updateOrder(op: OperationRow, events: EventRow[], token: string): Promise<Decision> {
    const prior = this.possiblyApplied(events, 'order');
    const read = await this.providers.order.get(op.customer_id, op.order_id);
    if (read.kind === 'unknown') return retry('ORDER_READ_UNAVAILABLE', [outcomeEvent('ORDER_READ', read)]);
    if (read.kind === 'rejected') {
      const e = [outcomeEvent('ORDER_READ', read)];
      return prior ? escalate('ORDER_UNAVAILABLE_AFTER_WRITE', e) : transition('REJECTED', 'ORDER_NOT_FOUND', { events: e });
    }
    const order = read.body.order;
    const seen = { step: 'ORDER_READ', reason_code: 'PROVIDER_OK', result: 'ok', detail: { address_id: order.address_id, version: order.version, status: order.status } };

    if (order.address_id === op.target_address_id) return transition('UPDATING_CARRIER', 'ORDER_AT_TARGET', { events: [seen] });
    if (!isEligibleForAddressChange(order.status)) {
      return prior ? escalate('ORDER_INELIGIBLE_AFTER_WRITE', [seen]) : transition('REJECTED', 'ORDER_NO_LONGER_ELIGIBLE', { events: [seen] });
    }
    if (order.version !== op.validated_order_version) {
      return prior ? escalate('ORDER_CHANGED_AFTER_WRITE', [seen]) : transition('REJECTED', 'ORDER_CHANGED_CONCURRENTLY', { events: [seen] });
    }

    const body = { address_id: op.target_address_id, idempotency_key: `${op.id}_order_v${order.version}`, expected_version: order.version };
    await this.logDispatch(op, token, WRITE_DISPATCHED.order, { provider: 'order', key: body.idempotency_key, expected_version: body.expected_version });
    const write = await this.providers.order.change(op.customer_id, op.order_id, body);
    await this.crash('after_provider_write', op);

    if (write.kind === 'ok') {
      const e = outcomeEvent('ORDER_WRITE_RESULT', write, { provider_reference: String(write.body.mutation.id), detail: { key: body.idempotency_key, replayed: write.replayed } });
      return transition('UPDATING_CARRIER', 'ORDER_UPDATED', { events: [seen, e] });
    }
    const e = [seen, outcomeEvent('ORDER_WRITE_RESULT', write, { detail: { key: body.idempotency_key } })];
    if (write.kind === 'unknown') return transition('PENDING_RECONCILIATION', 'ORDER_WRITE_OUTCOME_UNKNOWN', { events: e });
    if (write.code === 'VERSION_CONFLICT') return retry('ORDER_VERSION_CONFLICT', e);
    return prior ? escalate('ORDER_REJECTED_AFTER_PRIOR_WRITE', e) : transition('REJECTED', 'ORDER_WRITE_REJECTED', { events: e });
  }

  private async updateCarrier(op: OperationRow, events: EventRow[], token: string): Promise<Decision> {
    const ref = op.carrier_ref;
    if (!ref) return escalate('CARRIER_REFERENCE_MISSING');
    const prior = this.possiblyApplied(events, 'carrier');
    const read = await this.providers.carrier.get(ref);
    if (read.kind === 'unknown') return retry('CARRIER_READ_UNAVAILABLE', [outcomeEvent('CARRIER_READ', read)]);
    if (read.kind === 'rejected') {
      const e = [outcomeEvent('CARRIER_READ', read)];
      return prior ? escalate('SHIPMENT_UNAVAILABLE_AFTER_WRITE', e) : transition('COMPENSATING', 'SHIPMENT_NOT_FOUND', { events: e });
    }
    const shipment = read.body.shipment;
    const seen = { step: 'CARRIER_READ', reason_code: 'PROVIDER_OK', result: 'ok', detail: { address_id: shipment.address_id, version: shipment.version, status: shipment.status } };

    if (shipment.address_id === op.target_address_id) return transition('VERIFYING', 'CARRIER_AT_TARGET', { events: [seen] });
    if (shipment.status !== 'AWAITING_PICKUP') {
      return prior ? escalate('SHIPMENT_DISPATCHED_AFTER_WRITE', [seen]) : transition('COMPENSATING', 'SHIPMENT_DISPATCHED', { events: [seen] });
    }

    const body = { address_id: op.target_address_id, idempotency_key: `${op.id}_carrier_v${shipment.version}`, expected_version: shipment.version };
    await this.logDispatch(op, token, WRITE_DISPATCHED.carrier, { provider: 'carrier', key: body.idempotency_key, expected_version: body.expected_version });
    const write = await this.providers.carrier.change(ref, body);
    await this.crash('after_provider_write', op);

    if (write.kind === 'ok') {
      const e = outcomeEvent('CARRIER_WRITE_RESULT', write, { provider_reference: String(write.body.mutation.id), detail: { key: body.idempotency_key, replayed: write.replayed } });
      return transition('VERIFYING', 'CARRIER_UPDATED', { events: [seen, e] });
    }
    const e = [seen, outcomeEvent('CARRIER_WRITE_RESULT', write, { detail: { key: body.idempotency_key } })];
    if (write.kind === 'unknown') return transition('PENDING_RECONCILIATION', 'CARRIER_WRITE_OUTCOME_UNKNOWN', { events: e });
    if (write.code === 'VERSION_CONFLICT') return retry('CARRIER_VERSION_CONFLICT', e);
    return prior ? escalate('CARRIER_REJECTED_AFTER_PRIOR_WRITE', e) : transition('COMPENSATING', 'CARRIER_WRITE_REJECTED', { events: e });
  }

  /** ADR-0009 §5: status-by-key, then a read, then (only if keys are unsupported) back to the write state. */
  private async reconcile(op: OperationRow, events: EventRow[]): Promise<Decision> {
    const last = [...events].reverse().find((e) => e.step === WRITE_DISPATCHED.order || e.step === WRITE_DISPATCHED.carrier);
    const d = last?.detail as DispatchDetail | undefined;
    if (!d) return escalate('RECONCILIATION_TARGET_MISSING');
    const next: OperationStatus = d.provider === 'order' ? 'UPDATING_CARRIER' : 'VERIFYING';
    const back: OperationStatus = d.provider === 'order' ? 'UPDATING_ORDER' : 'UPDATING_CARRIER';
    const ref = op.carrier_ref ?? '';

    const status = d.provider === 'order' ? await this.providers.order.status(op.customer_id, op.order_id, d.key) : await this.providers.carrier.status(ref, d.key);
    const statusEvent = outcomeEvent('RECONCILE_STATUS_QUERY', status, { detail: { provider: d.provider, key: d.key } });
    if (status.kind === 'ok') return transition(next, 'WRITE_CONFIRMED_APPLIED', { events: [statusEvent] });
    if (status.kind === 'rejected' && status.code === 'MUTATION_NOT_FOUND') return transition(back, 'WRITE_CONFIRMED_NOT_APPLIED', { events: [statusEvent] });
    const keysUnsupported = status.kind === 'rejected' && status.code === 'NOT_SUPPORTED';
    if (status.kind === 'rejected' && !keysUnsupported) return escalate('RECONCILIATION_ENTITY_UNAVAILABLE', [statusEvent]);

    const read = d.provider === 'order' ? await this.providers.order.get(op.customer_id, op.order_id) : await this.providers.carrier.get(ref);
    if (read.kind !== 'ok') return retry('RECONCILIATION_UNAVAILABLE', [statusEvent, outcomeEvent('RECONCILE_READ', read)]);
    const entity = 'order' in read.body ? read.body.order : read.body.shipment;
    const readEvent = { step: 'RECONCILE_READ', reason_code: 'PROVIDER_OK', result: 'ok', detail: { provider: d.provider, address_id: entity.address_id, version: entity.version } };
    if (entity.address_id === op.target_address_id) return transition(next, 'WRITE_OBSERVED_APPLIED', { events: [statusEvent, readEvent] });
    // Not at target. Without key lookup, re-entering the write state is safe: it re-reads
    // and writes with expected_version, so a landed write cannot be applied twice.
    if (keysUnsupported) return transition(back, 'WRITE_NOT_OBSERVED_RETRYING_GUARDED', { events: [statusEvent, readEvent] });
    return retry('OUTCOME_CANNOT_BE_ESTABLISHED', [statusEvent, readEvent]);
  }

  private async verify(op: OperationRow): Promise<Decision> {
    const v = await readBothSystems(this.providers, op, op.target_address_id);
    if (v.kind === 'matches') return transition('COMPLETED', 'VERIFIED_BOTH_SYSTEMS', { evidence: { verification: v.evidence } });
    if (v.kind === 'differs') return retry('VERIFICATION_MISMATCH', [{ step: 'VERIFY_READ', reason_code: 'MISMATCH', result: 'differs', detail: { ...v.evidence } }]);
    return retry('VERIFICATION_UNAVAILABLE', [{ step: 'VERIFY_READ', reason_code: 'UNAVAILABLE', result: 'unknown', detail: { reason: v.detail } }]);
  }

  /** ADR-0009 §6: version-guarded revert of the order, then proof both systems are at the original. */
  private async compensate(op: OperationRow, token: string): Promise<Decision> {
    const original = op.original_address_id;
    if (!original) return escalate('ORIGINAL_ADDRESS_MISSING');
    const read = await this.providers.order.get(op.customer_id, op.order_id);
    if (read.kind === 'unknown') return retry('COMPENSATION_READ_UNAVAILABLE', [outcomeEvent('COMPENSATION_ORDER_READ', read)]);
    if (read.kind === 'rejected') return escalate('COMPENSATION_ORDER_UNAVAILABLE', [outcomeEvent('COMPENSATION_ORDER_READ', read)]);
    const order = read.body.order;
    const seen = { step: 'COMPENSATION_ORDER_READ', reason_code: 'PROVIDER_OK', result: 'ok', detail: { address_id: order.address_id, version: order.version } };

    if (order.address_id === original) {
      const v = await readBothSystems(this.providers, op, original);
      if (v.kind === 'matches') return transition('REJECTED', 'CHANGE_REVERSED_AFTER_CARRIER_REJECTION', { evidence: { compensation: v.evidence }, events: [seen] });
      if (v.kind === 'unavailable') return retry('COMPENSATION_VERIFY_UNAVAILABLE', [seen]);
      return escalate('COMPENSATION_CARRIER_MISMATCH', [seen, { step: 'COMPENSATION_VERIFY_READ', reason_code: 'MISMATCH', result: 'differs', detail: { ...v.evidence } }]);
    }
    if (order.address_id !== op.target_address_id) return escalate('ORDER_CHANGED_DURING_COMPENSATION', [seen]);

    const body = { address_id: original, idempotency_key: `${op.id}_order_revert_v${order.version}`, expected_version: order.version };
    await this.logDispatch(op, token, 'ORDER_COMPENSATION_DISPATCHED', { provider: 'order', key: body.idempotency_key, expected_version: body.expected_version });
    const write = await this.providers.order.change(op.customer_id, op.order_id, body);
    await this.crash('after_provider_write', op);
    const e = [seen, outcomeEvent('ORDER_COMPENSATION_RESULT', write, { detail: { key: body.idempotency_key } })];
    if (write.kind === 'ok') return { kind: 'continue', reason: 'ORDER_REVERTED', events: e };
    // Unknown or conflicting: the next step re-reads the order and decides.
    if (write.kind === 'unknown' || write.code === 'VERSION_CONFLICT') return retry('COMPENSATION_WRITE_UNCONFIRMED', e);
    return escalate('COMPENSATION_REJECTED', e);
  }
}
