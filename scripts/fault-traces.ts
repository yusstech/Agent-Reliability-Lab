// Regenerates the Phase 02 fault-trace evidence: every named scenario, from a freshly
// seeded fixture, against the real provider HTTP APIs. Output is deterministic and is
// checked against the committed copy by tests/integration/fault-traces.test.ts.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateFixture } from '../fixtures/generate.ts';
import { PROVIDER_SCENARIOS } from '../scenarios/provider-faults.ts';
import { assertLocalDatabase, assertNotProduction, loadConfig } from '../src/config.ts';
import { createPool } from '../src/db/pool.ts';
import { seed } from '../src/db/seed.ts';
import { startProviderPair } from '../src/providers/harness.ts';
import { pickTarget, runScenarioTrace } from '../src/providers/trace.ts';
import { renderTraceSummary } from '../src/providers/trace-report.ts';

const config = loadConfig();
assertNotProduction(config.nodeEnv, 'traces');
assertLocalDatabase(config.databaseUrl, 'traces');

const OUT_DIR = path.resolve(import.meta.dirname, '../docs/PHASES/evidence');
const fixture = generateFixture();
const target = pickTarget(fixture);
const observer = createPool(config.databaseUrl);
const providers = await startProviderPair(config.databaseUrl);
try {
  const traces = [];
  for (const scenario of PROVIDER_SCENARIOS) {
    await seed(observer, fixture);
    traces.push(await runScenarioTrace({ ...providers, observer, clientTimeoutMs: 100 }, scenario, target));
  }
  const doc = { fixture: { version: fixture.version, seed: fixture.seed }, client_timeout_ms: 100, traces };
  await writeFile(path.join(OUT_DIR, 'phase-02-fault-traces.json'), `${JSON.stringify(doc, null, 2)}\n`);
  await writeFile(path.join(OUT_DIR, 'phase-02-fault-traces.md'), renderTraceSummary(doc));
  console.log(`wrote ${traces.length} scenario traces to docs/PHASES/evidence/`);
} finally {
  await providers.close();
  await seed(observer, fixture);
  await observer.end();
}
