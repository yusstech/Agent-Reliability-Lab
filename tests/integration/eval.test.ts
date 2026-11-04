import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateFixture } from '../../fixtures/generate.ts';
import { buildDataset } from '../../src/eval/dataset.ts';
import { runCaseOnVariantA } from '../../src/eval/run-variant-a.ts';
import { scoreCaseRun, summarize } from '../../src/eval/score.ts';
import { seed } from '../../src/db/seed.ts';
import { startVariantA, type VariantA } from '../../src/workflow/harness.ts';
import { testDatabaseUrl } from '../helpers/db.ts';

const fixture = generateFixture();
const dataset = buildDataset(fixture, 20261104);
// One case per category, covering the harness's script actions.
const PICK = ['success', 'unauthorized', 'ineligible', 'duplicate', 'timeout_before_write', 'timeout_after_write', 'partial', 'concurrent'].map(
  (cat) => dataset.cases.find((c) => c.category === cat)!,
);
let a: VariantA;
beforeAll(async () => {
  a = await startVariantA(testDatabaseUrl(), { clientTimeoutMs: 500 });
});
afterAll(async () => {
  await seed(a.pool, fixture);
  await a.close();
});

it('EV-01 the harness runs one case of every category on variant A, and each scores correct', async () => {
  const raws = [];
  for (const c of PICK) raws.push(await runCaseOnVariantA(a, fixture, c, 1, { deadlineMs: 60_000 }));
  const scores = raws.map((r, i) => scoreCaseRun(PICK[i]!, r));
  expect(scores.filter((s) => s.harness_error)).toEqual([]);
  expect(scores.map((s) => [s.case_id, s.correct, s.violations])).toEqual(PICK.map((c) => [c.id, true, []]));
  const summary = summarize({ ...dataset, cases: PICK }, scores);
  expect(summary.false_claim.count).toBe(0);
  expect(summary.unauthorized_mutations).toBe(0);
}, 120_000);

it('EV-02 variant A is deterministic: repeating a case gives the same score (except latency)', async () => {
  const c = dataset.cases.find((x) => x.variant === 'order-keys-ignored' && x.category === 'timeout_after_write')!;
  const once = scoreCaseRun(c, await runCaseOnVariantA(a, fixture, c, 1, { deadlineMs: 60_000 }));
  const twice = scoreCaseRun(c, await runCaseOnVariantA(a, fixture, c, 2, { deadlineMs: 60_000 }));
  const strip = ({ latency_ms: _l, rep: _r, ...rest }: typeof once) => rest;
  expect(strip(twice)).toEqual(strip(once));
}, 120_000);
