import type { AgentSummary, Summary } from './score.ts';

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const ci = (c: [number, number]) => `[${pct(c[0])}, ${pct(c[1])}]`;

/** Results table regenerated from the scored raw records. Generated; do not edit by hand. */
export function renderReport(manifest: Record<string, unknown>, s: Summary & { agent?: AgentSummary }): string {
  const m = manifest as { run_id: string; dataset: { version: string; sha256: string }; plan: { frozen_tag: string; matches_frozen: boolean }; git: { commit: string; dirty: boolean }; variant: string; k: number; model?: string | null; label?: string };
  const zero = (x: { count: number; exact95_upper_by_cases?: number }) => (x.count === 0 && x.exact95_upper_by_cases !== undefined ? ` (0 observed; exact 95% upper bound ${pct(x.exact95_upper_by_cases)}, n = cases)` : '');
  const L = [
    `# Run ${m.run_id} (generated)`,
    '',
    `Variant **${m.variant}**${m.model ? ` · model \`${m.model}\`` : ''} · dataset \`${m.dataset.version}\` (sha256 \`${m.dataset.sha256.slice(0, 12)}…\`) · k = ${m.k} · commit \`${m.git.commit.slice(0, 7)}\`${m.git.dirty ? ' (**dirty**)' : ''} · plan \`${m.plan.frozen_tag}\`${m.plan.matches_frozen ? '' : ' (**plan differs from frozen tag**)'}`,
    '',
    'Regenerated from `events.jsonl` by `npm run eval:score`. Definitions: Evaluation Plan §8 (and deviations log). **This is a development-set (R-dev) run, not the confirmatory run.**',
    '',
    ...(m.label ? [`> ${m.label}`, ''] : []),
    '## Headline',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Case-runs (valid / harness errors) | ${s.counts.valid} / ${s.counts.harness_errors} (${s.counts.cases} cases × k = ${s.counts.k}) |`,
    `| **False claims** | ${s.false_claim.count} / ${s.false_claim.n}${zero(s.false_claim)} |`,
    `| False success | ${s.false_success.count}${zero(s.false_success)} |`,
    `| False failure | ${s.false_failure.count}${zero(s.false_failure)} |`,
    `| Verified completion (cases expecting completion) | ${s.verified_completion.count} / ${s.verified_completion.n} = ${pct(s.verified_completion.rate)} ${ci(s.verified_completion.wilson95)} |`,
    `| Correct outcome (§8.3) | ${pct(s.correct.rate)}; bootstrap 95% by cases ${ci(s.correct.bootstrap95_by_cases)} |`,
    `| Gated success (correct + no procedural violation) | ${pct(s.gated_success.rate)} |`,
    `| Manual review / unfinished | ${pct(s.manual_review.rate)} / ${pct(s.unfinished.rate)} |`,
    `| Unauthorized mutations | ${s.unauthorized_mutations} |`,
    `| Duplicate side effects | ${s.duplicate_side_effects} |`,
    `| pass^k | ${Object.entries(s.pass_hat_k).map(([k, v]) => `pass^${k} ${pct(v)}`).join(' · ')} |`,
    `| Latency p50 / p95 (simulated environment) | ${Math.round(s.latency_ms.p50)} ms / ${Math.round(s.latency_ms.p95)} ms (n = ${s.latency_ms.n}) |`,
    `| Model cost | ${s.cost.note} |`,
    '',
    '## Invariant and procedure violations',
    '',
    `| ${Object.keys(s.invariant_violations).join(' | ')} |`,
    `| ${Object.keys(s.invariant_violations).map(() => '---').join(' | ')} |`,
    `| ${Object.values(s.invariant_violations).join(' | ')} |`,
    '',
    `Procedure: ${Object.entries(s.procedure_violations).map(([k, v]) => `${k} = ${v}`).join(', ')}.`,
    '',
    ...(s.agent
      ? [
          '## Episodes and cost (model-directed variants)',
          '',
          '| Metric | Value |',
          '| --- | --- |',
          `| Primary-episode outcomes | ${Object.entries(s.agent.primary_episode_outcomes).map(([k, v]) => `${k} ${v}`).join(' · ')} |`,
          `| Protocol failures (no report, turn cap, max_tokens) | ${s.agent.protocol_failures} |`,
          `| Model refusals | ${s.agent.model_refusals} |`,
          `| Model calls${s.agent.scripted_turns ? ' / scripted policy turns (no model)' : ''} | ${s.agent.model_calls}${s.agent.scripted_turns ? ` / ${s.agent.scripted_turns}` : ''} |`,
          `| Tokens in / cache write / cache read / out | ${s.agent.tokens.input} / ${s.agent.tokens.cache_creation} / ${s.agent.tokens.cache_read} / ${s.agent.tokens.output} |`,
          `| Cost (list prices) | ${s.agent.model_calls === 0 ? 'none: no model was called' : `$${s.agent.usd.toFixed(4)}${s.agent.usd_per_verified_completion === null ? '' : `; $${s.agent.usd_per_verified_completion.toFixed(4)} per verified completion`}`} |`,
          '',
        ]
      : []),
    '## By category',
    '',
    '| Category | Case-runs | Correct | completed | not_changed | needs_review | pending |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...Object.entries(s.by_category).map(([cat, v]) => `| ${cat} | ${v.case_runs} | ${v.correct} | ${v.claims.completed} | ${v.claims.not_changed} | ${v.claims.needs_review} | ${v.claims.pending} |`),
    '',
  ];
  return `${L.join('\n')}\n`;
}
