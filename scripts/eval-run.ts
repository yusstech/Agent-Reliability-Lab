// Runs the R-dev dataset against one variant, k times per case, and writes
// results/<run-id>/ (or results/scratch/<run-id>/ with --scratch).
//
//   npm run eval -- [--k 5] [--cases RDEV-001,RDEV-002] [--scratch]                 variant A
//   npm run eval -- --variant NAIVE --k 5                                            no-model negative control
//   npm run eval -- --variant B0 --model claude-haiku-5-5 --k 2 --dry-run            plan + cost projection, no calls
//   npm run eval -- --variant B0 --model claude-haiku-5-5 --k 2 --allow-paid --budget-usd 5
//
// Model variants (B0–B3, C) make paid API calls. They refuse to start without --allow-paid
// and a --budget-usd within the study cap (ADR-0007), and stop before crossing the budget.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { generateFixture } from '../fixtures/generate.ts';
import { LOOP, type ModelClient } from '../src/agent/loop.ts';
import { BudgetMeter, createPaidClient } from '../src/agent/model-client.ts';
import { createNaiveClient } from '../src/agent/naive.ts';
import { enforcementMatrix, POLICY, RUNG_IDS, RUNGS, type RungId } from '../src/agent/policy.ts';
import { MODELS, PRICES, STUDY_CAP_USD, type ModelId } from '../src/agent/pricing.ts';
import { SELECTOR_PROMPT, SELECTOR_TOOLS } from '../src/agent/selector.ts';
import { toolDefinitions } from '../src/agent/tools.ts';
import { assertLocalDatabase, assertNotProduction, loadConfig } from '../src/config.ts';
import { scoreRun } from '../src/eval/artifacts.ts';
import { type Dataset, datasetDigest, type EvalCase } from '../src/eval/dataset.ts';
import { runCaseOnAgent } from '../src/eval/run-agent.ts';
import { type RawCaseRun, runCaseOnVariantA } from '../src/eval/run-variant-a.ts';
import { runCaseOnVariantC } from '../src/eval/run-variant-c.ts';
import { seed } from '../src/db/seed.ts';
import { startVariantA } from '../src/workflow/harness.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLAN = path.join(ROOT, 'docs/EVALUATION_PLAN.md');
const FROZEN_TAG = 'eval-plan-v1.2';
const ENV = { client_timeout_ms: 500, deadline_ms: 120_000, worker: 'production defaults: backoff min(100*2^n, 30000) ms; budgets 5/3/50; lease 30 s' };
const VARIANTS = ['A', 'NAIVE', ...RUNG_IDS, 'C'] as const;
type Variant = (typeof VARIANTS)[number];

const { values } = parseArgs({
  options: {
    k: { type: 'string', default: '5' },
    cases: { type: 'string' },
    scratch: { type: 'boolean', default: false },
    dataset: { type: 'string', default: 'datasets/r-dev-v1.json' },
    variant: { type: 'string', default: 'A' },
    model: { type: 'string' },
    'allow-paid': { type: 'boolean', default: false },
    'budget-usd': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const variant = values.variant as Variant;
if (!VARIANTS.includes(variant)) throw new Error(`--variant must be one of ${VARIANTS.join(', ')}`);
const isModel = variant === 'C' || (RUNG_IDS as readonly string[]).includes(variant);
const isAgentFamily = variant === 'NAIVE' || (RUNG_IDS as readonly string[]).includes(variant);
if (isModel && !(MODELS as readonly string[]).includes(values.model ?? '')) throw new Error(`--model must be one of ${MODELS.join(', ')} for variant ${variant}`);
if (!isModel && values.model) throw new Error(`variant ${variant} takes no --model`);
const model = isModel ? (values.model as ModelId) : null;

const sh = (cmd: string) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const dataset = JSON.parse(await readFile(path.join(ROOT, values.dataset), 'utf8')) as Dataset;
const only = values.cases ? new Set(values.cases.split(',')) : null;
const cases = dataset.cases.filter((c) => !only || only.has(c.id));
const k = Number(values.k);
if (!Number.isInteger(k) || k < 1 || k > 20) throw new Error('--k must be 1-20');

// ------------------------------------------------------------------ plan and projection
const rungId = (RUNG_IDS as readonly string[]).includes(variant) ? (variant as RungId) : variant === 'NAIVE' ? 'B0' : null;
/** Episodes one case needs on a B rung: concurrent agents, a duplicate request, a competing request. */
const episodesFor = (c: EvalCase) => {
  const w = c.script.find((s) => s.kind === 'run_workers');
  return (w && w.kind === 'run_workers' ? w.count : 1) + (c.script.some((s) => s.kind === 'submit_again') ? 1 : 0) + (c.script.some((s) => s.kind === 'competing_request') ? 1 : 0);
};
const episodes = variant === 'C' ? cases.length * k : isAgentFamily ? cases.reduce((t, c) => t + episodesFor(c), 0) * k : 0;
const toolsJson = rungId ? JSON.stringify(toolDefinitions(RUNGS[rungId])) : variant === 'C' ? JSON.stringify(SELECTOR_TOOLS) : '';
const promptText = variant === 'C' ? SELECTOR_PROMPT : rungId ? POLICY : '';
/**
 * Rough projection (no API call): ADR-0007's episode shape, with the cached prefix sized
 * from the actual prompt and tools at ~3.5 characters per token. The pilot replaces this.
 */
function projectUsd(m: ModelId): { per_episode: number; total: number; assumptions: string } {
  const p = PRICES[m];
  const prefix = Math.round((promptText.length + toolsJson.length) / 3.5);
  if (variant === 'C') {
    const usd = ((prefix + 400) * p.input + 500 * p.output) / 1e6;
    return { per_episode: usd, total: usd * episodes, assumptions: `1 call; ~${prefix} prefix tokens + ~400 context tokens uncached (single call per case); ~500 output tokens incl. thinking` };
  }
  const turns = 8;
  const convo = 48_000 - prefix * turns; // ADR-0007: ~48K input tokens per episode in total
  const usd = (prefix * p.cacheWrite * 0.1 + prefix * (turns - 0.1) * p.cacheRead + Math.max(convo, 0) * p.input + 4_000 * p.output) / 1e6;
  return { per_episode: usd, total: usd * episodes, assumptions: `${turns} turns; ~${prefix}-token cached prefix (written ~1 in 10 episodes, read otherwise); remaining input of ~48K/episode uncached; 4K output incl. thinking (ADR-0007 shape)` };
}
if (values['dry-run']) {
  console.log(`variant ${variant}${model ? ` · ${model}` : ''} · ${cases.length} cases × k=${k} · ${episodes} model episodes`);
  if (model) {
    const pr = projectUsd(model);
    console.log(`projected cost: ~$${pr.total.toFixed(2)} (~$${pr.per_episode.toFixed(4)} per episode). Assumptions: ${pr.assumptions}.`);
    console.log(`study cap $${STUDY_CAP_USD}; a paid run needs --allow-paid --budget-usd <n>. Nothing was called.`);
  }
  process.exit(0);
}

// ------------------------------------------------------------------ gates and stack
const config = loadConfig();
assertNotProduction(config.nodeEnv, 'eval');
assertLocalDatabase(config.databaseUrl, 'eval');
let client: (ModelClient & { meter?: BudgetMeter }) | null = null;
if (variant === 'NAIVE') client = createNaiveClient();
if (isModel) client = createPaidClient({ model: model as string, allowPaid: values['allow-paid'] === true, budgetUsd: Number(values['budget-usd']) });

const commit = sh('git rev-parse HEAD');
const short = model ? `-${model.replace(/^claude-/, '').split('-')[0]}` : '';
const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${variant}${short}-${commit.slice(0, 7)}`;
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
const pg = (await a.pool.query<{ server_version: string }>('SHOW server_version')).rows[0]?.server_version;
if (!pg) throw new Error('could not read the PostgreSQL version for the manifest');
const sdkVersion = JSON.parse(await readFile(path.join(ROOT, 'node_modules/@anthropic-ai/sdk/package.json'), 'utf8')).version as string;
const manifest: Record<string, unknown> = {
  run_id: runId,
  created_at: new Date().toISOString(),
  variant,
  model,
  k,
  scope: only ? 'subset' : 'full',
  git: { commit, branch: sh('git rev-parse --abbrev-ref HEAD'), dirty: sh('git status --porcelain').length > 0 },
  operator: sh('git config user.name'),
  dataset: { path: values.dataset, version: dataset.version, seed: dataset.seed, sha256: datasetDigest(dataset), cases: cases.length },
  plan: { path: 'docs/EVALUATION_PLAN.md', sha256: sha256(planText), frozen_tag: FROZEN_TAG, frozen_sha256: frozen, matches_frozen: sha256(planText) === frozen },
  environment: { node: process.version, postgres: pg, os: `${os.type()} ${os.release()}`, arch: os.arch(), ...ENV },
};
if (variant !== 'A') {
  Object.assign(manifest, {
    record_version: 2,
    rung: rungId,
    enforcement: rungId ? enforcementMatrix(RUNGS[rungId]) : 'C: every invariant in code (variant A pipeline)',
    prompts: { system_sha256: sha256(promptText), tools_sha256: sha256(toolsJson) },
    loop: isModel
      ? { sdk: `@anthropic-ai/sdk@${sdkVersion}`, max_turns: variant === 'C' ? 1 : LOOP.maxTurns, max_tokens: LOOP.maxTokens, effort: LOOP.effort, thinking: 'adaptive (parameter omitted: model default)', tool_choice: 'auto', strict_tools: true, refusal_fallbacks: 'off (fallbacks parameter omitted)', cache_breakpoint: 'end of system prompt (tools + policy)' }
      : { policy: 'scripted naive-v1 behind the same loop; no API calls', max_turns: LOOP.maxTurns },
    episodes_planned: episodes,
    budget_usd: isModel ? Number(values['budget-usd']) : 0,
    ...(variant === 'NAIVE' ? { label: 'NEGATIVE CONTROL: scripted, no model. It runs B0 tools through the same loop, runner and scorer to show the harness reports false claims when they happen. It is not evidence about agents.' } : {}),
  });
}
await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const eventsFile = path.join(dir, 'events.jsonl');
await writeFile(eventsFile, '');
let stopped: string | null = null;
try {
  let done = 0;
  outer: for (let rep = 1; rep <= k; rep++) {
    for (const c of cases) {
      let raw: RawCaseRun;
      try {
        if (variant === 'A') raw = await runCaseOnVariantA(a, fixture, c, rep, { deadlineMs: ENV.deadline_ms });
        else if (variant === 'C') raw = await runCaseOnVariantC(a, fixture, c, rep, { deadlineMs: ENV.deadline_ms, client: client as ModelClient });
        else raw = await runCaseOnAgent(a, fixture, c, rep, { deadlineMs: ENV.deadline_ms, clientTimeoutMs: ENV.client_timeout_ms, rung: RUNGS[rungId as RungId], client: client as ModelClient, variant });
      } catch (err) {
        if ((err as Error).name === 'BudgetExceededError') {
          stopped = (err as Error).message;
          break outer;
        }
        throw err;
      }
      await appendFile(eventsFile, `${JSON.stringify(raw)}\n`);
      done++;
      if (done % 25 === 0) console.log(`${done}/${cases.length * k} case-runs${client?.meter ? ` · $${client.meter.spent.toFixed(4)} spent` : ''}`);
    }
  }
} finally {
  await seed(a.pool, fixture);
  await a.close();
}
if (stopped || client?.meter) {
  manifest.completion = { stopped_early: stopped, usd_spent: client?.meter?.spent ?? 0, model_calls: client?.meter?.calls ?? 0 };
  await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
const { summary } = await scoreRun(dir, dataset);
console.log(`run ${runId}: ${summary.counts.valid} valid case-runs, false claims ${summary.false_claim.count}, correct ${(100 * (summary.correct.rate ?? 0)).toFixed(1)}%`);
if (stopped) console.log(`STOPPED EARLY: ${stopped}`);
console.log(`wrote ${path.relative(ROOT, dir)}/`);
