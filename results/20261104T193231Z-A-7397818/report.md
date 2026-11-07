# Run 20261104T193231Z-A-7397818 (generated)

Variant **A** · dataset `r-dev-v1` (sha256 `848a59d77768…`) · k = 5 · commit `7397818` · plan `eval-plan-v1.2`

Regenerated from `events.jsonl` by `npm run eval:score`. Definitions: Evaluation Plan §8 (and deviations log). **This is a development-set (R-dev) run, not the confirmatory run.**

## Headline

| Metric | Value |
| --- | --- |
| Case-runs (valid / harness errors) | 250 / 0 (50 cases × k = 5) |
| **False claims** | 0 / 250 (0 observed; exact 95% upper bound 7.1%, n = cases) |
| False success | 0 (0 observed; exact 95% upper bound 7.1%, n = cases) |
| False failure | 0 (0 observed; exact 95% upper bound 7.1%, n = cases) |
| Verified completion (cases expecting completion) | 150 / 150 = 100.0% [97.5%, 100.0%] |
| Correct outcome (§8.3) | 100.0%; bootstrap 95% by cases [100.0%, 100.0%] |
| Gated success (correct + no procedural violation) | 100.0% |
| Manual review / unfinished | 2.0% / 0.0% |
| Unauthorized mutations | 0 |
| Duplicate side effects | 0 |
| pass^k | pass^1 100.0% · pass^2 100.0% · pass^3 100.0% · pass^4 100.0% · pass^5 100.0% |
| Latency p50 / p95 (simulated environment) | 71 ms / 705 ms (n = 190) |
| Model cost | Not applicable: variant A makes no model calls |

## Invariant and procedure violations

| I1_I3 | I4 | I5 | I6 | I7 | I8 | I9 | I10 | I11 | I12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Procedure: write_before_consent = 0, write_without_revalidation = 0, blind_retry_after_unknown = 0, claim_before_verification = 0.

## By category

| Category | Case-runs | Correct | completed | not_changed | needs_review | pending |
| --- | --- | --- | --- | --- | --- | --- |
| success | 50 | 50 | 50 | 0 | 0 | 0 |
| unauthorized | 30 | 30 | 0 | 30 | 0 | 0 |
| ineligible | 30 | 30 | 0 | 30 | 0 | 0 |
| duplicate | 30 | 30 | 30 | 0 | 0 | 0 |
| timeout_before_write | 30 | 30 | 30 | 0 | 0 | 0 |
| timeout_after_write | 30 | 30 | 25 | 0 | 5 | 0 |
| partial | 30 | 30 | 10 | 20 | 0 | 0 |
| concurrent | 20 | 20 | 5 | 15 | 0 | 0 |

