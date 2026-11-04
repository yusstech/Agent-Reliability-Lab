import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateFixture } from '../../fixtures/generate.ts';
import { buildDataset, CATEGORIES, datasetDigest } from '../../src/eval/dataset.ts';

const fixture = generateFixture();
const SEED = 20261104;

describe('R-dev dataset (Evaluation Plan §8.10)', () => {
  it('DS-01 is deterministic and the committed file is exactly the generator output', async () => {
    const d = buildDataset(fixture, SEED);
    expect(datasetDigest(buildDataset(fixture, SEED))).toBe(datasetDigest(d));
    const committed = JSON.parse(await readFile(path.resolve(import.meta.dirname, '../../datasets/r-dev-v1.json'), 'utf8'));
    expect(committed).toEqual(d);
  });

  it('DS-02 composition matches the frozen plan', () => {
    const d = buildDataset(fixture, SEED);
    const by = (k: 'category' | 'variant') => d.cases.reduce<Record<string, number>>((m, c) => ({ ...m, [c[k]]: (m[c[k]] ?? 0) + 1 }), {});
    expect(d.cases).toHaveLength(50);
    expect(by('category')).toEqual({ success: 10, unauthorized: 6, ineligible: 6, duplicate: 6, timeout_before_write: 6, timeout_after_write: 6, partial: 6, concurrent: 4 });
    expect(Object.keys(by('category')).sort()).toEqual([...CATEGORIES].sort());
    const v = by('variant');
    expect(v).toMatchObject({ 'other-customers-order': 3, 'other-customers-address': 3, shipped: 3, delivered: 2, 'address-unchanged': 1, 'carrier-permanent-rejection': 2, 'shipment-dispatched-before-carrier-write': 2, 'stale-carrier-read': 2 });
  });

  it('DS-03 every case is internally valid against the fixture', () => {
    const d = buildDataset(fixture, SEED);
    const orders = new Map(fixture.orders.map((o) => [o.id, o]));
    const addr = new Map(fixture.saved_addresses.map((a) => [a.id, a]));
    for (const c of d.cases) {
      const o = orders.get(c.intent.order_id)!;
      expect(o, c.id).toBeDefined();
      expect(o.customer_id, c.id).toBe(c.order_owner);
      expect(o.carrier_ref, c.id).toBe(c.carrier_ref);
      expect(o.address_id, c.id).toBe(c.original_address_id);
      expect(addr.has(c.intent.new_address_id), c.id).toBe(true);
      expect(c.expected.acceptable_claims.length, c.id).toBeGreaterThan(0);
      expect(c.expected.rationale.length, c.id).toBeGreaterThan(10);
      if (c.variant === 'other-customers-order') expect(c.caller).not.toBe(c.order_owner);
      if (c.variant === 'other-customers-address') expect(addr.get(c.intent.new_address_id)!.customer_id).not.toBe(c.caller);
    }
  });
});
