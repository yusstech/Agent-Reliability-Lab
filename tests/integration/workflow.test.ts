import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedCrash } from '../../src/workflow/worker.ts';
import { startStack, type Stack, target } from '../helpers/stack.ts';

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(() => s.close());
beforeEach(() => s.reset());

const T = target.to_address_id;
const O = target.from_address_id;
const HANG = { hang_ms: 1500 } as const;

/** The study's core invariant, checked after every scenario: the claim matches reality. */
async function claimMatchesTruth(opId: string) {
  const view = await s.view(opId);
  const truth = await s.truth();
  const both = truth.order.address_id === T && truth.shipment.address_id === T;
  const neither = truth.order.address_id === O && truth.shipment.address_id === O;
  if (view.customer_status === 'completed') expect(both, 'completed must mean both systems changed').toBe(true);
  if (view.customer_status === 'not_changed') expect(neither, 'not_changed must mean neither system changed').toBe(true);
  return { view, truth };
}

describe('variant A end to end', () => {
  it('WK-01 happy path: both systems updated once, then verified', async () => {
    const id = await s.confirmed();
    await s.worker().runUntilIdle();
    const { view, truth } = await claimMatchesTruth(id);
    expect(view).toMatchObject({ status: 'COMPLETED', customer_status: 'completed', verified: { order_address_id: T, carrier_address_id: T } });
    expect(truth).toMatchObject({ order_mutations: 1, carrier_mutations: 1 });
  });

  it('WK-02 timeout before write (keys honoured): reconciled as not applied, retried, one write', async () => {
    await s.faults('order', { rules: [{ fault: 'TIMEOUT_BEFORE_WRITE', target: '*', params: HANG }] });
    const id = await s.confirmed();
    await s.worker().runUntilIdle();
    const { view, truth } = await claimMatchesTruth(id);
    expect(view.status).toBe('COMPLETED');
    expect(truth).toMatchObject({ order_mutations: 1, carrier_mutations: 1 });
    expect((await s.events(id)).map((e) => e.reason_code)).toContain('WRITE_CONFIRMED_NOT_APPLIED');
  });

  it('WK-03 timeout after write (keys honoured): reconciled as applied, never re-sent', async () => {
    await s.faults('order', { rules: [{ fault: 'TIMEOUT_AFTER_WRITE', target: '*', params: HANG }] });
    const id = await s.confirmed();
    await s.worker().runUntilIdle();
    const { view, truth } = await claimMatchesTruth(id);
    expect(view.status).toBe('COMPLETED');
    expect(truth).toMatchObject({ order_mutations: 1, carrier_mutations: 1 });
    expect((await s.events(id)).map((e) => e.reason_code)).toContain('WRITE_CONFIRMED_APPLIED');
  });

  it('WK-04 timeout after write, keys IGNORED: still exactly one write (read + version guard)', async () => {
    await s.faults('order', { honour_idempotency_keys: false, rules: [{ fault: 'TIMEOUT_AFTER_WRITE', target: '*', params: HANG }] });
    await s.faults('carrier', { honour_idempotency_keys: false });
    const id = await s.confirmed();
    await s.worker().runUntilIdle();
    const { view, truth } = await claimMatchesTruth(id);
    expect(view.status).toBe('COMPLETED');
    expect(truth).toMatchObject({ order_mutations: 1, carrier_mutations: 1 });
    expect((await s.events(id)).map((e) => e.reason_code)).toContain('WRITE_OBSERVED_APPLIED');
  });

  it('WK-05 request duplicated in transit, keys ignored: the version guard stops the duplicate', async () => {
    await s.faults('order', { honour_idempotency_keys: false, rules: [{ fault: 'DUPLICATE_DELIVERY', target: '*' }] });
    const id = await s.confirmed();
    await s.worker().runUntilIdle();
    expect((await claimMatchesTruth(id)).truth).toMatchObject({ order_mutations: 1 });
  });

  it('WK-06 carrier permanently rejects: the order is reverted, verified, and the customer told not_changed', async () => {
    await s.faults('carrier', { rules: [{ fault: 'PERMANENT_REJECTION', target: '*' }] });
    const id = await s.confirmed();
    await s.worker().runUntilIdle();
    const { view, truth } = await claimMatchesTruth(id);
    expect(view).toMatchObject({ status: 'REJECTED', customer_status: 'not_changed', reason: 'CHANGE_REVERSED_AFTER_CARRIER_REJECTION' });
    expect(truth).toMatchObject({ order: { address_id: O }, shipment: { address_id: O }, order_mutations: 2, carrier_mutations: 0 });
    expect((await s.events(id)).some((e) => e.to_status === 'COMPENSATING')).toBe(true);
  });

  it('WK-07 order ships between validation and write: rejected before any write', async () => {
    // after: 1 skips the request-path read, so the change lands behind the worker's read.
    await s.faults('order', { rules: [{ fault: 'CONCURRENT_STATUS_CHANGE', target: '*', after: 1 }] });
    const id = await s.confirmed();
    await s.worker().runUntilIdle();
    const { view, truth } = await claimMatchesTruth(id);
    expect(view).toMatchObject({ status: 'REJECTED', customer_status: 'not_changed', reason: 'ORDER_NO_LONGER_ELIGIBLE' });
    expect(truth).toMatchObject({ order_mutations: 0, carrier_mutations: 0 });
  });

  it('WK-08 stale read after the carrier write: verification retries instead of failing or guessing', async () => {
    await s.faults('carrier', { rules: [{ fault: 'SLOW_CONSISTENCY', target: '*', params: { stale_reads: 2 } }] });
    const id = await s.confirmed();
    await s.worker().runUntilIdle();
    const { view, truth } = await claimMatchesTruth(id);
    expect(view.status).toBe('COMPLETED');
    expect(truth).toMatchObject({ carrier_mutations: 1 });
    expect((await s.events(id)).map((e) => e.reason_code)).toContain('VERIFICATION_MISMATCH');
  });

  it('WK-09 write happened but nothing can confirm it: escalates, never claims completion', async () => {
    await s.faults('order', {
      rules: [
        { fault: 'TIMEOUT_AFTER_WRITE', target: '*', params: HANG },
        { fault: 'UNAVAILABLE_STATUS_QUERY', target: '*', on: 'status_query', times: null },
        // Reads fail too, but only after the request path and the worker's first read.
        { fault: 'UNAVAILABLE_STATUS_QUERY', target: '*', on: 'read', after: 2, times: null },
      ],
    });
    const id = await s.confirmed();
    await s.worker().runUntilIdle();
    const { view, truth } = await claimMatchesTruth(id);
    expect(view).toMatchObject({ status: 'NEEDS_MANUAL_REVIEW', customer_status: 'needs_review' });
    expect(truth).toMatchObject({ order: { address_id: T }, order_mutations: 1, carrier_mutations: 0 });
  });

  it('WK-10 a dead order system before any write: escalates after the retry budget, nothing changed', async () => {
    const id = await s.confirmed();
    await s.faults('order', { rules: [{ fault: 'UNAVAILABLE_STATUS_QUERY', target: '*', on: 'read', times: null }] });
    await s.worker({ maxStepAttempts: 3 }).runUntilIdle();
    const { view, truth } = await claimMatchesTruth(id);
    expect(view).toMatchObject({ status: 'NEEDS_MANUAL_REVIEW', reason: 'ORDER_READ_UNAVAILABLE_UNRESOLVED' });
    expect(truth).toMatchObject({ order_mutations: 0, carrier_mutations: 0 });
  });
});

describe('durability: crashes, duplicate delivery, fencing', () => {
  for (const point of ['after_dispatch_logged', 'after_provider_write'] as const) {
    it(`WK-11 a worker that dies ${point.replaceAll('_', ' ')} is recovered without a second write`, async () => {
      const id = await s.confirmed();
      let crashed = false;
      const doomed = s.worker({
        crashAt: (p, op) => {
          if (!crashed && p === point && op.status === 'UPDATING_ORDER') return (crashed = true);
          return false;
        },
      });
      await expect(doomed.runUntilIdle()).rejects.toBeInstanceOf(SimulatedCrash);
      // The dead worker still holds the lease; nobody else may touch the operation until it expires.
      expect(await s.worker().runUntilIdle()).toBe(0);
      await s.pool.query(`UPDATE ledger.operations SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
      await s.worker().runUntilIdle();
      const { view, truth } = await claimMatchesTruth(id);
      expect(view.status).toBe('COMPLETED');
      expect(truth).toMatchObject({ order_mutations: 1, carrier_mutations: 1 });
    });
  }

  it('WK-12 the same work delivered to several workers at once is applied exactly once', async () => {
    const id = await s.confirmed();
    await Promise.all(Array.from({ length: 4 }, () => s.worker().runUntilIdle()));
    const { view, truth } = await claimMatchesTruth(id);
    expect(view.status).toBe('COMPLETED');
    expect(truth).toMatchObject({ order_mutations: 1, carrier_mutations: 1 });
  });

  it('WK-13 a worker that lost its lease cannot record anything afterwards', async () => {
    const id = await s.confirmed();
    let stolen = false;
    const slow = s.worker({
      crashAt: async (p) => {
        // Right after it has written, another worker takes over the (expired) lease.
        if (p === 'after_provider_write' && !stolen) {
          stolen = true;
          await s.pool.query(`UPDATE ledger.operations SET lease_token = gen_random_uuid() WHERE id = $1`, [id]);
        }
        return false;
      },
    });
    await expect(slow.runUntilIdle()).rejects.toThrow(/lease/);
    // The fenced-out worker recorded neither the write result nor a transition.
    expect((await s.events(id)).some((e) => e.step === 'ORDER_WRITE_RESULT')).toBe(false);
    await s.pool.query(`UPDATE ledger.operations SET lease_token = NULL, lease_expires_at = NULL WHERE id = $1`, [id]);
    await s.worker().runUntilIdle();
    const { view, truth } = await claimMatchesTruth(id);
    expect(view.status).toBe('COMPLETED');
    expect(truth).toMatchObject({ order_mutations: 1, carrier_mutations: 1 });
  });

  it('WK-14 every recorded transition is a legal one (the event log is consistent)', async () => {
    await s.faults('carrier', { rules: [{ fault: 'PERMANENT_REJECTION', target: '*' }] });
    const id = await s.confirmed();
    await s.worker().runUntilIdle();
    const transitions = (await s.events(id)).filter((e) => e.to_status);
    for (let i = 1; i < transitions.length; i++) expect(transitions[i]!.from_status).toBe(transitions[i - 1]!.to_status);
  });
});
