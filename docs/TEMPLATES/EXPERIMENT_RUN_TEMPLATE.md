# Experiment run <run-id>

Prefer the machine-generated `results/<run-id>/manifest.json`; this template is for the human summary.

- **Identity:** run ID, UTC timestamp, git commit, branch, operator, dataset version, seed
- **Environment:** Node / Postgres / OS versions, service settings
- **Variant:** A deterministic | B agent-directed | C hybrid
- **Agent configuration (B/C only):** provider, exact model ID, SDK version, prompt/tool-schema hashes, sampling, max steps, token budget
- **Cases:** count, selection, exclusions
- **Outcomes:** link to `cases.csv`, `summary.json`, `events.jsonl`
- **Unexpected results:** each with a failure investigation
- **Limitations:** nondeterminism, missing telemetry, methodology changes

Never fill a value by hand that the run did not produce. Use `Not measured` / `Not implemented`.
