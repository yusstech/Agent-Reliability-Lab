// Runs the R-dev dataset against variant A, k times per case, and writes
// results/<run-id>/ (or results/scratch/<run-id>/ with --scratch).
// Usage: npm run eval -- [--k 5] [--cases RDEV-001,RDEV-002] [--scratch]
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { generateFixture } from '../fixtures/generate.ts';
import { assertLocalDatabase, assertNotProduction, loadConfig } from '../src/config.ts';
import { scoreRun } from '../src/eval/artifacts.ts';
import { type Dataset, datasetDigest } from '../src/eval/dataset.ts';
import { runCaseOnVariantA } from '../src/eval/run-variant-a.ts';
import { seed } from '../src/db/seed.ts';
import { startVariantA } from '../src/workflow/harness.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLAN = path.join(ROOT, 'docs/EVALUATION_PLAN.md');
const FROZEN_TAG = 'eval-plan-v1.2';
const ENV = { client_timeout_ms: 500, deadline_ms: 120_000, worker: 'production defaults: backoff min(100*2^n, 30000) ms; budgets 5/3/50; lease 30 s' };

const { values } = parseArgs({ options: { k: { type: 'string', default: '5' }, cases: { type: 'string' }, scratch: { type: 'boolean', default: false }, dataset: { type: 'string', default: 'datasets/r-dev-v1.json' } } });
const config = loadConfig();
assertNotProduction(config.nodeEnv, 'eval');
assertLocalDatabase(config.databaseUrl, 'eval');

const sh = (cmd: string) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const dataset = JSON.parse(await readFile(path.join(ROOT, values.dataset), 'utf8')) as Dataset;
const only = values.cases ? new Set(values.cases.split(',')) : null;
const cases = dataset.cases.filter((c) => !only || only.has(c.id));
const k = Number(values.k);
if (!Number.isInteger(k) || k < 1 || k > 20) throw new Error('--k must be 1-20');

const commit = sh('git rev-parse HEAD');
const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-A-${commit.slice(0, 7)}`;
const dir = path.join(ROOT, 'results', values.scratch ? 'scratch' : '', runId);
await mkdir(dir, { recursive: true });

const planText = await readFile(PLAN, 'utf8');
let frozen = '';
try {
  frozen = sha256(execSync(`git show ${FROZEN_TAG}:docs/EVALUATION_PLAN.md`, { cwd: ROOT })); // exact bytes, no trimming
} catch {
  frozen = 'unavailable';
}
const fixture = generateFixture();
const a = await startVariantA(config.databaseUrl, { clientTimeoutMs: ENV.client_timeout_ms });
const pg = (await a.pool.query<{ v: string }>('SHOW server_version')).rows[0]?.v;
const manifest = {
  run_id: runId,
  created_at: new Date().toISOString(),
  variant: 'A',
  model: null,
  k,
  scope: only ? 'subset' : 'full',
  git: { commit, branch: sh('git rev-parse --abbrev-ref HEAD'), dirty: sh('git status --porcelain').length > 0 },
  operator: sh('git config user.name'),
  dataset: { path: values.dataset, version: dataset.version, seed: dataset.seed, sha256: datasetDigest(dataset), cases: cases.length },
  plan: { path: 'docs/EVALUATION_PLAN.md', sha256: sha256(planText), frozen_tag: FROZEN_TAG, frozen_sha256: frozen, matches_frozen: sha256(planText) === frozen },
  environment: { node: process.version, postgres: pg, os: `${os.type()} ${os.release()}`, arch: os.arch(), ...ENV },
};
await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const eventsFile = path.join(dir, 'events.jsonl');
await writeFile(eventsFile, '');
try {
  let done = 0;
  for (let rep = 1; rep <= k; rep++) {
    for (const c of cases) {
      const raw = await runCaseOnVariantA(a, fixture, c, rep, { deadlineMs: ENV.deadline_ms });
      await appendFile(eventsFile, `${JSON.stringify(raw)}\n`);
      done++;
      if (done % 25 === 0) console.log(`${done}/${cases.length * k} case-runs`);
    }
  }
} finally {
  await seed(a.pool, fixture);
  await a.close();
}
const { summary } = await scoreRun(dir, dataset);
console.log(`run ${runId}: ${summary.counts.valid} valid case-runs, false claims ${summary.false_claim.count}, correct ${(100 * (summary.correct.rate ?? 0)).toFixed(1)}%`);
console.log(`wrote ${path.relative(ROOT, dir)}/`);
