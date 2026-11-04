# Phase 04: Reliability Evaluation Harness

- **Status:** Tested. All done-when criteria pass. The gate is signed off when this branch is merged and the commit is recorded below.
- **Dates:** 2026-11-04 → 2026-11-04
- **Commit at gate:** not yet merged (branch `phase-04-evaluation`)

## 1. Goal / research value
Turn the implementation into a **falsifiable, repeatable experiment**. Every number must be regenerable from raw events, and the definitions must be fixed in public before anything is measured. That way, variants B and C (Phase 05) are scored by exactly the same rules, and neither can be favoured after the fact.

## 2. Scope / non-goals
**In:**
- freezing the Evaluation Plan (pre-registration);
- the seeded R-dev dataset (50 cases);
- the case runner for variant A;
- the pure scorer for every §8 metric;
- the statistics;
- run artifacts;
- two full baseline runs of variant A.

**Out:**
- R-conf and R-hold, which are generated after all variants are frozen (Plan §6);
- the language set and variants B and C (Phase 05);
- paired comparisons such as McNemar, which need a second variant.

## 3. Architecture & implementation

| Concern | Code / artifact |
| --- | --- |
| Frozen definitions | [EVALUATION_PLAN.md §8](../EVALUATION_PLAN.md#8-measurement-definitions-v12), tag `eval-plan-v1.2`; [deviations log](../EVALUATION_DEVIATIONS.md) |
| Dataset generator / data | [src/eval/dataset.ts](../../src/eval/dataset.ts) → [datasets/r-dev-v1.json](../../datasets/r-dev-v1.json) (`npm run dataset`) |
| Runner (raw observations only) | [src/eval/run-variant-a.ts](../../src/eval/run-variant-a.ts) |
| Scorer (pure) | [src/eval/score.ts](../../src/eval/score.ts) |
| Statistics | [src/eval/stats.ts](../../src/eval/stats.ts) |
| Artifacts and report | [src/eval/artifacts.ts](../../src/eval/artifacts.ts), [src/eval/report.ts](../../src/eval/report.ts) |
| Commands | `npm run eval -- --k 5`, `npm run eval:score -- results/<run-id>` |

**Each run writes `results/<run-id>/`:**
- `manifest.json`: run ID, commit, dirty flag, operator, dataset version and hash, plan hash compared with the frozen tag, Node/Postgres/OS, and the harness settings;
- `events.jsonl`: one raw record per case-run;
- `cases.csv`, `summary.json` and `report.md`, all derived from `events.jsonl`.

## 4. Alternatives & trade-offs
[ADR-0010](../DECISIONS/ADR-0010-evaluation-harness.md) records the choices:
- raw records first, with scoring derived purely from them;
- truth read from the stores, and the claim read from the customer API;
- expected outcomes taken from design intent, written before measurement;
- sequential, reseeded isolation;
- intervals over cases rather than case-runs;
- official runs committed.

It also answers the roadmap's five Phase 04 questions, which are now fixed in Plan §8:
- the completion-rate denominator;
- what counts as a false success;
- test isolation;
- the latency source;
- per-provider failure classification.

## 5. Reliability & security concerns
- **Pre-registration integrity.** The plan was frozen and pushed (tag `eval-plan-v1.2` → `57de113`) **before** any scored run. Each manifest checks the plan file against the tag (`matches_frozen: true` in both runs).
- **Deviation #1.** While building the scorer, before any scored run, the frozen false-failure definition turned out to misclassify a truthful answer: in RDEV-049 another actor changes the address. It was corrected and logged with its reason and expected effect. The change affects only truth class `other`.
- **The scorer is checked against itself.** Each detector has a unit test on a perturbed record that must trigger it (SC-02…SC-10), so a scorer that never flags anything would fail the suite.
- **No secrets in evidence.** Raw records hold response codes, the ledger and provider logs. They hold no session or confirmation tokens: the runner never writes tokens to records.

## 6. Validation

**Environment** (from the run 2 manifest): Node v26.8.1, PostgreSQL 16.14, Darwin 25.6.0 arm64. Provider client timeout 500 ms; fault hangs 3 000 ms; worker on production defaults; deadline 120 s per case-run.

```
npm test                              # 20 files, 145 tests passed
npm run eval -- --k 5                 # runs 1 and 2 below
npm run eval:score -- results/<run>   # re-derives every file from events.jsonl
```

| Done-when criterion | Evidence | Result |
| --- | --- | --- |
| A reviewer can rerun the complete deterministic suite | Run 2 was an independent full rerun. It reproduced run 1 **exactly on all 250 case-runs**: every outcome column and the whole summary. Only latency differs (p50 55 vs 71 ms) | Pass |
| A reviewer can regenerate the results table from raw events | `eval:score` on run 1 regenerated `cases.csv`, `summary.json` and `report.md` **byte-for-byte** | Pass |
| The suite includes timeout-after-write | 6 TAW cases (30 case-runs), including keys ignored and status endpoint down | Pass |
| Zero or documented failed assertions | 0 harness errors; 0 unexpected results (§6, Results) | Pass |
| Measured success, failure and latency | Below | Pass |
| A manifest with commit, versions, seed and date | Both runs; run 1's lacks the Postgres version (see Found and fixed) | Pass |

### Results: R-dev baseline, variant A ([run 2 report](../../results/20261104T193231Z-A-7397818/report.md))
Status label: **Observed** on the development set. This is not the confirmatory run.

| Metric | Value |
| --- | --- |
| Case-runs | 250 (50 cases × k = 5), 0 harness errors |
| False claims | **0 of 250.** The exact 95% upper bound is **7.1%**, computed with n = 50 cases, because repetitions are not independent |
| Verified completion (cases expecting it) | 150 / 150 |
| Correct outcome / gated success | 100% / 100% |
| Manual review | 2.0%: all 5 case-runs of RDEV-040, where the write landed and nothing could confirm it. That case expects escalation, and A escalated |
| Unauthorized mutations / duplicate side effects | 0 / 0 |
| Invariant (I1–I12) and procedure violations | 0 |
| pass^1 … pass^5 | 100% at every k |
| Latency p50 / p95 | 71 ms / 705 ms (simulated environment; includes client timeouts and backoff) |
| Variant A runtime size | 1 193 lines (workflow, ledger, worker, verifier, adapters, intent layer, domain). Engineering hours: **Not measured** |

**How to read this.** Variant A was built in Phases 02–03 against exactly these eight fault types, by the same author who wrote the dataset. A perfect score on R-dev is therefore **expected, and weak evidence**. It shows that the harness can register a correct system and that A meets its own design. It does not show that A is reliable in general. That is exactly the overfitting threat in Plan §7. The tests of generality are **R-hold**, faults sampled after the freeze from an external incident taxonomy, and the comparison with B and C on R-conf.

**Unexpected results:** none. Every case-run's claim was within its case's `acceptable_claims`, decided in advance. No failure investigation was required.

**Found and fixed during the phase:**
1. **Pre-write reads were logged out of order, and a crash could drop them.** This was a worker issue, found while defining the §8.5 procedure check. The worker recorded its pre-write read *after* the dispatch, inside the result transaction. The log order therefore misstated what happened, and a crash between the dispatch and the result lost the read entirely. Regenerating the Phase 03 traces showed this in P03-10: the old trace was missing the crashed worker's read. Reads are now committed together with the dispatch. The regenerated traces differ only in event order, plus that one recovered read, with all outcomes identical.
2. **Deviation #1**, described in §5.
3. **Run 1's manifest omitted the Postgres version.** The query read a column `SHOW` doesn't return. The run is kept unedited as evidence, the harness now fails loudly instead, and run 2 is complete.
4. **The frozen-plan hash could depend on trailing whitespace.** It now hashes the exact bytes at the tag.

## 7. Limitations
- **Overfitting.** R-dev measures A against the faults it was designed for; see "How to read this" above. Its 100% is a ceiling check, not a finding.
- **No end-to-end negative control yet.** The scorer's detectors are proven on synthetic perturbed records (SC-02…10), and the truth reads were proven in Phase 03. But no *deliberately faulty real system* has yet been run end to end through the harness to show it reports false claims when they happen. The Agentic Benchmark Checklist step (Plan §6.6) should add one before the confirmatory run. Variant B0 will also exercise this naturally.
- **Single operator and single machine.** Both runs were on one laptop. A third-party rerun from a clean clone hasn't been done.
- **Simulated latency.** It is dominated by the configured 500 ms client timeout and backoff, and isn't comparable with production.
- **Dataset variety is modest.** It covers 19 distinct orders and 8 callers. The foreign address in the unauthorized-address cases is always the first non-owned address (`addr_001`).

## 8. Outcome / next decision
All done-when criteria pass. The harness reproduces itself, and the baseline is recorded with an honest reading. **Next, Phase 05:** variants B0–B3 and C. They use the same dataset, scorer and definitions; Claude Haiku 5.5 is primary, with a cost pilot first ([ADR-0007](../DECISIONS/ADR-0007-models-harness-and-budget.md)). Then the language set, the freeze of every variant, the generation of R-conf and R-hold, and the confirmatory run.

**What changed in our thinking:** defining procedure metrics precisely surfaced a real fidelity bug in A's own logs (finding 1). The same discipline will matter more for model variants, whose traces are less structured. Their records must make "what happened, in what order" just as unambiguous, or the procedure metrics won't be comparable.
