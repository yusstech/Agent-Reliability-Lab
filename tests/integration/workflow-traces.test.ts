import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { WORKFLOW_SCENARIOS } from '../../scenarios/workflow-scenarios.ts';
import { FAULT_MODES } from '../../src/providers/faults.ts';
import { generateWorkflowTraces } from '../../src/workflow/trace.ts';
import { testDatabaseUrl } from '../helpers/db.ts';

const GOLDEN = path.resolve(import.meta.dirname, '../../docs/PHASES/evidence/phase-03-workflow-traces.json');

it('TR-03 workflow scenarios cover every provider fault mode plus a worker crash', () => {
  expect(new Set(WORKFLOW_SCENARIOS.map((s) => s.fault))).toEqual(new Set([...FAULT_MODES, 'WORKER_CRASH']));
});

it('TR-04 regenerating the workflow traces reproduces the committed evidence, with no false claims', async () => {
  const doc = await generateWorkflowTraces(testDatabaseUrl());
  expect(doc.traces.filter((t) => t.false_claim)).toEqual([]);
  expect(doc).toEqual(JSON.parse(await readFile(GOLDEN, 'utf8')));
}, 120_000);
