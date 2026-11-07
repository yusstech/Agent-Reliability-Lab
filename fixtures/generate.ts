// Deterministic base fixture. Same seed => byte-identical output (see tests/unit/fixtures.test.ts).
// All data is synthetic. No real people, addresses or credentials.
import { createHash } from 'node:crypto';
import type { CarrierShipment, Customer, Order, OrderStatus, SavedAddress, ShipmentStatus } from '../src/domain/types.ts';
import { ORDER_STATUSES } from '../src/domain/types.ts';

export const DEFAULT_SEED = 1042;
export const FIXTURE_VERSION = 'base-v1';

export interface MockSession {
  /** Plain token presented by tests/demo clients. Only its hash is stored. */
  token: string;
  customer_id: string;
}

export interface Fixture {
  version: string;
  seed: number;
  customers: Customer[];
  saved_addresses: SavedAddress[];
  orders: Order[];
  shipments: CarrierShipment[];
  sessions: MockSession[];
}

const CUSTOMER_COUNT = 8;
const STREETS = ['Harbour Road', 'Mill Lane', 'Station Street', 'Cedar Avenue', 'Quarry Close', 'Kestrel Way', 'Orchard Row', 'Beacon Hill'];
const CITIES = ['Northfield', 'Easton', 'Westbury', 'Southmoor'];
const LABELS = ['Home', 'Office', 'Parents'];

const SHIPMENT_STATUS_FOR: Record<OrderStatus, ShipmentStatus> = {
  PLACED: 'AWAITING_PICKUP',
  PACKING: 'AWAITING_PICKUP',
  SHIPPED: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED',
};

/** mulberry32: small, well-known deterministic PRNG. Not for security use. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number, width = 3) => String(n).padStart(width, '0');

export function generateFixture(seed: number = DEFAULT_SEED): Fixture {
  if (!Number.isSafeInteger(seed)) throw new Error('seed must be a safe integer');
  const rand = prng(seed);
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;

  const fixture: Fixture = {
    version: FIXTURE_VERSION,
    seed,
    customers: [],
    saved_addresses: [],
    orders: [],
    shipments: [],
    sessions: [],
  };

  let addressSeq = 0;
  let orderSeq = 0;

  for (let c = 1; c <= CUSTOMER_COUNT; c++) {
    const customerId = `cus_${pad(c)}`;
    fixture.customers.push({ id: customerId });
    fixture.sessions.push({ token: `mock_session_${customerId}`, customer_id: customerId });

    const addressIds: string[] = [];
    const addressCount = int(2, 3);
    for (let a = 0; a < addressCount; a++) {
      const id = `addr_${pad(++addressSeq)}`;
      addressIds.push(id);
      fixture.saved_addresses.push({
        id,
        customer_id: customerId,
        normalized_address: `${LABELS[a]}: ${int(1, 199)} ${pick(STREETS)}, ${pick(CITIES)} ${String.fromCharCode(65 + int(0, 25))}${int(10, 99)}`,
      });
    }

    // Statuses rotate per customer so every status is guaranteed to appear for any seed.
    const orderCount = int(2, 4);
    for (let o = 0; o < orderCount; o++) {
      const orderNumber = ++orderSeq;
      const status = ORDER_STATUSES[(c + o) % ORDER_STATUSES.length] as OrderStatus;
      const addressId = pick(addressIds);
      const carrierRef = `shp_${pad(orderNumber, 4)}`;
      fixture.orders.push({
        id: `ord_${pad(1000 + orderNumber, 4)}`,
        customer_id: customerId,
        status,
        address_id: addressId,
        version: 1,
        carrier_ref: carrierRef,
      });
      fixture.shipments.push({ carrier_ref: carrierRef, address_id: addressId, status: SHIPMENT_STATUS_FOR[status], version: 1 });
    }
  }

  return fixture;
}

/** Reads FIXTURE_SEED (decimal integer) or falls back to DEFAULT_SEED. */
export function fixtureSeedFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FIXTURE_SEED;
  if (raw === undefined || raw === '') return DEFAULT_SEED;
  if (!/^\d{1,15}$/.test(raw)) throw new Error('FIXTURE_SEED must be a non-negative decimal integer');
  return Number(raw);
}

/** Stable digest of a fixture, used to prove determinism and detect accidental drift. */
export function fixtureDigest(fixture: Fixture): string {
  return createHash('sha256').update(JSON.stringify(fixture), 'utf8').digest('hex');
}
