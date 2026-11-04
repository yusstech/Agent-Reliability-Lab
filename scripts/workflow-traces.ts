// Regenerates the Phase 03 workflow-trace evidence; checked byte-for-byte by
// tests/integration/workflow-traces.test.ts.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertLocalDatabase, assertNotProduction, loadConfig } from '../src/config.ts';
import { generateWorkflowTraces } from '../src/workflow/trace.ts';
import { renderWorkflowSummary } from '../src/workflow/trace-report.ts';

const config = loadConfig();
assertNotProduction(config.nodeEnv, 'traces');
assertLocalDatabase(config.databaseUrl, 'traces');

const doc = await generateWorkflowTraces(config.databaseUrl);
const dir = path.resolve(import.meta.dirname, '../docs/PHASES/evidence');
await writeFile(path.join(dir, 'phase-03-workflow-traces.json'), `${JSON.stringify(doc, null, 2)}\n`);
await writeFile(path.join(dir, 'phase-03-workflow-traces.md'), renderWorkflowSummary(doc));
console.log(`wrote ${doc.traces.length} workflow traces to docs/PHASES/evidence/`);
