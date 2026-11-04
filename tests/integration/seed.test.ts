import { afterAll, expect, it } from 'vitest';
import type pg from 'pg';
import { generateFixture } from '../../fixtures/generate.ts';
import { hashToken } from '../../src/security/token-hash.ts';
import { dumpFixtureTables, seed } from '../../src/db/seed.ts';
import { createTestPool } from '../helpers/db.ts';

const pool: pg.Pool = createTestPool();
afterAll(() => pool.end());

it('SD-01 seeding twice yields identical database contents, matching the fixture', async () => {
  const fixture = generateFixture();
  await seed(pool, fixture);
  const first = await dumpFixtureTables(pool);
  await seed(pool, fixture);
  const second = await dumpFixtureTables(pool);
  expect(second).toEqual(first);

  expect(first.orders).toEqual([...fixture.orders].sort((a, b) => a.id.localeCompare(b.id)));
  expect(first.shipments).toEqual([...fixture.shipments].sort((a, b) => a.carrier_ref.localeCompare(b.carrier_ref)));
  expect(first.saved_addresses).toHaveLength(fixture.saved_addresses.length);
});

it('SD-02 session tokens are stored only as hashes', async () => {
  const fixture = generateFixture();
  await seed(pool, fixture);
  const { rows } = await pool.query<{ token_sha256: string }>('SELECT token_sha256 FROM identity.mock_sessions');
  const stored = new Set(rows.map((r) => r.token_sha256));
  for (const s of fixture.sessions) {
    expect(stored.has(s.token)).toBe(false);
    expect(stored.has(hashToken(s.token))).toBe(true);
  }
});
