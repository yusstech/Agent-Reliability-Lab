import { describe, expect, it } from 'vitest';
import { DEFAULT_SEED, fixtureDigest, generateFixture } from '../../fixtures/generate.ts';
import { ORDER_STATUSES } from '../../src/domain/types.ts';

describe('deterministic fixtures', () => {
  it('FX-01 same seed produces identical output', () => {
    expect(generateFixture(DEFAULT_SEED)).toEqual(generateFixture(DEFAULT_SEED));
    expect(fixtureDigest(generateFixture(7))).toBe(fixtureDigest(generateFixture(7)));
  });

  it('FX-02 different seeds produce different output', () => {
    expect(fixtureDigest(generateFixture(1))).not.toBe(fixtureDigest(generateFixture(2)));
  });

  it('FX-03 default fixture digest is pinned (update deliberately, with a FIXTURE_VERSION bump)', () => {
    expect(fixtureDigest(generateFixture())).toMatchInlineSnapshot(`"95661cd2b2515c4192be1c3c2204e1606a91ccb65a10b18eefe04f57b9cf9508"`);
  });

  it('FX-04 fixture is internally consistent for any seed', () => {
    for (const seed of [DEFAULT_SEED, 1, 99, 123456]) {
      const f = generateFixture(seed);
      const addressOwner = new Map(f.saved_addresses.map((a) => [a.id, a.customer_id]));
      const shipments = new Map(f.shipments.map((s) => [s.carrier_ref, s]));
      for (const order of f.orders) {
        expect(addressOwner.get(order.address_id)).toBe(order.customer_id);
        expect(shipments.get(order.carrier_ref)?.address_id).toBe(order.address_id);
      }
      expect(new Set(f.orders.map((o) => o.status))).toEqual(new Set(ORDER_STATUSES));
      expect(new Set(f.orders.map((o) => o.id)).size).toBe(f.orders.length);
      expect(new Set(f.saved_addresses.map((a) => a.id)).size).toBe(f.saved_addresses.length);
    }
  });
});
