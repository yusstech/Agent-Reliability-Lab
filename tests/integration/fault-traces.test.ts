import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type pg from 'pg';
import { generateFixture } from '../../fixtures/generate.ts';
import { PROVIDER_SCENARIOS } from '../../scenarios/provider-faults.ts';
import { seed } from '../../src/db/seed.ts';
import { FAULT_MODES } from '../../src/providers/faults.ts';
import { pickTarget, runScenarioTrace } from '../../src/providers/trace.ts';
import { createTestPool } from '../helpers/db.ts';
import { startTestProviders } from '../helpers/providers.ts';

const GOLDEN = path.resolve(import.meta.dirname, '../../docs/PHASES/evidence/phase-02-fault-traces.json');
const observer: pg.Pool = createTestPool();
let p: Awaited<ReturnType<typeof startTestProviders>>;
beforeAll(async () => {
  p = await startTestProviders();
});
afterAll(async () => {
  await p.close();
  await seed(observer, generateFixture());
  await observer.end();
});

it('TR-01 every fault mode has at least one named scenario', () => {
  expect(new Set(PROVIDER_SCENARIOS.map((s) => s.fault))).toEqual(new Set(FAULT_MODES));
  expect(new Set(PROVIDER_SCENARIOS.map((s) => s.id)).size).toBe(PROVIDER_SCENARIOS.length);
});

it('TR-02 regenerating every scenario trace reproduces the committed evidence exactly', async () => {
  const fixture = generateFixture();
  const target = pickTarget(fixture);
  const traces = [];
  for (const scenario of PROVIDER_SCENARIOS) {
    await seed(observer, fixture);
    traces.push(await runScenarioTrace({ ...p, observer, clientTimeoutMs: 100 }, scenario, target));
  }
  const golden = JSON.parse(await readFile(GOLDEN, 'utf8'));
  expect({ fixture: { version: fixture.version, seed: fixture.seed }, client_timeout_ms: 100, traces }).toEqual(golden);
}, 60_000);
