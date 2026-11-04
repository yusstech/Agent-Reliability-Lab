import { describe, expect, it } from 'vitest';
import { FaultConfigError, FaultEngine, parseScenarioConfig } from '../../src/providers/faults.ts';

const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof FaultConfigError ? err.details.map((d) => d.path) : 'other';
  }
};

describe('fault engine', () => {
  it('FE-01 resolves per-provider default hook points and parameters', () => {
    const order = parseScenarioConfig('order', { scenario_id: 's', rules: [{ fault: 'CONCURRENT_STATUS_CHANGE', target: '*' }] });
    const carrier = parseScenarioConfig('carrier', { scenario_id: 's', rules: [{ fault: 'CONCURRENT_STATUS_CHANGE', target: '*' }] });
    expect(order.rules[0]?.on).toBe('read');
    expect(carrier.rules[0]?.on).toBe('mutation');
    expect(order.rules[0]?.params).toEqual({ manifest: 'hang', hang_ms: 1000, stale_reads: 2 });
    expect(order.honourIdempotencyKeys).toBe(true);
  });

  it('FE-02 rejects faults on hook points where they have no meaning', () => {
    expect(codeOf(() => parseScenarioConfig('order', { scenario_id: 's', rules: [{ fault: 'TIMEOUT_AFTER_WRITE', target: '*', on: 'read' }] }))).toEqual(['rules.0.on']);
    expect(codeOf(() => parseScenarioConfig('order', { scenario_id: 's', rules: [{ fault: 'NORMAL', target: '*' }] }))).not.toBeNull();
    expect(codeOf(() => parseScenarioConfig('order', { scenario_id: 's', rules: [{ fault: 'TIMEOUT_BEFORE_WRITE', target: 'ord_1; DROP' }] }))).not.toBeNull();
    expect(codeOf(() => parseScenarioConfig('order', { scenario_id: 's', extra: 1 }))).not.toBeNull();
  });

  it('FE-03 fires on the n-th matching operation, for `times` occurrences, per target', () => {
    const e = new FaultEngine('order');
    e.load({ scenario_id: 's', rules: [{ fault: 'PERMANENT_REJECTION', target: 'ord_1001', after: 1, times: 2 }] });
    const fired = [1, 2, 3, 4].map(() => e.fire('mutation', 'ord_1001').length);
    expect(fired).toEqual([0, 1, 1, 0]);
    expect(e.fire('mutation', 'ord_1002')).toEqual([]);
    expect(e.fire('read', 'ord_1001')).toEqual([]);
  });

  it('FE-04 times: null fires on every match; reset clears everything', () => {
    const e = new FaultEngine('carrier');
    e.load({ scenario_id: 's', honour_idempotency_keys: false, rules: [{ fault: 'UNAVAILABLE_STATUS_QUERY', target: '*', times: null }] });
    expect([1, 2, 3].map(() => e.fire('status_query', 'shp_0001').length)).toEqual([1, 1, 1]);
    e.reset();
    expect(e.fire('status_query', 'shp_0001')).toEqual([]);
    expect(e.honoursIdempotencyKeys).toBe(true);
  });

  it('FE-05 stale snapshots are consumed one read at a time', () => {
    const e = new FaultEngine<{ v: number }>('carrier');
    e.markStale('shp_0001', { v: 1 }, 2);
    expect([e.takeStale('shp_0001'), e.takeStale('shp_0001'), e.takeStale('shp_0001')]).toEqual([{ v: 1 }, { v: 1 }, undefined]);
  });
});
