# ADR-0007: Claude models, a hand-written tool loop, and a capped budget

- **Status:** Accepted
- **Date:** 2026-11-04
- **Phase:** 01 (design, ahead of Phase 05)
- **Amends:** spec §11 (it named the OpenAI Agents SDK); [EVALUATION_PLAN §5](../EVALUATION_PLAN.md#5-statistics) (it asked for models from different providers)

## Context
The maintainer has Anthropic startup credits and a low budget. Three constraints follow.
1. **Models from one provider.** The evaluation plan asked for ≥2 models from different providers.
2. **Sampling can't be pinned.** From API version `2026-10-21`, `temperature`, `top_p` and `top_k` are rejected on every Claude model, so runs are stochastic by design. Repetition is the only control. Model behaviour is pinned through the exact model ID, `effort`, and the thinking configuration.
3. **Framework choice is a confound.** Prior work found that the agent stack matters more than model scale (arXiv:2610.32555).

Model facts below are from Anthropic's API reference, cached 2026-10-06. Re-check prices before the confirmatory run.

| Model | ID | Input $/MTok | Output $/MTok | Cache read |
| --- | --- | --- | --- | --- |
| Claude Haiku 5.5 | `claude-haiku-5-5` | 0.10 (≤100K prompt) | 0.50 | ~0.1× input |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 2.00 | 10.00 | 0.20 |

Cache writes cost 1.25× input with a 5-minute TTL. The minimum cacheable prefix is 512 tokens on both models. The Batches API costs 50% less but is asynchronous.

## Options considered
1. **OpenAI Agents SDK** (spec v0.2). It doesn't fit the credits, and it adds a framework layer we don't control.
2. **The Claude Agent SDK.** This is the Claude Code harness, with built-in file and bash tools. It is far more tool surface than the study wants, and its loop isn't ours to instrument.
3. **The Anthropic SDK Tool Runner.** It is less code, but it's a beta helper, and its loop policy (retries, step handling) becomes part of what we'd be measuring.
4. **A hand-written tool-use loop on `@anthropic-ai/sdk`** (pinned exact version). We control and log every turn, step limit, token count and error, and the loop is identical for every B rung and both models.

## Decision
Option 4, configured as follows.
- **Models:**
  - **Claude Haiku 5.5** is the primary model for all development and confirmatory runs.
  - **Claude Sonnet 5.5** is the second model, used **only in the confirmatory and held-out runs**, not during development.
  - Both use the same `effort: "medium"`, set explicitly because the two models have different defaults. Thinking is left at its default (adaptive), and `display` is omitted.
- **Single provider:** both models are Anthropic's. This **relaxes "different providers"** to "two capability tiers from one provider", and it is reported as a limitation. An open-weight model may be added later if budget allows. It is optional.
- **Refusal fallbacks are disabled.** Anthropic's general guidance is to enable server-side fallbacks. Here they would silently switch to a different model mid-episode and contaminate the comparison. A refusal is recorded as its own outcome (`MODEL_REFUSAL`), it counts against the variant, and the episode is not retried.
- **Loop rules:**
  - Hard caps of **12 model turns** and a fixed `max_tokens` per episode.
  - **Append-only history.** The API checks thinking blocks against edited history, and editing would also break caching.
  - `tool_choice: auto` on every tool. Forced tool choice returns a 400 on Sonnet 5.5, so the final `report_to_customer` call is required by instruction, and an episode without it scores as a protocol failure.
  - `strict: true` on every tool schema.
  - Every turn's `usage` (input, cache creation, cache read, output) is logged to `events.jsonl`.
- **Caching:** the policy prompt and tool list are byte-identical across all episodes of a rung, with a cache breakpoint at the end of that shared prefix. Cache-read rates are checked in the pilot.
- **Batches:** used for **single-call** workloads (variant C and the language set), where latency isn't a measured outcome for that run. Multi-turn B episodes run interactively, because latency is a metric.
- **Raters:** the free-text audit (EVALUATION_PLAN §4.1) uses the maintainer and one external rater. Both are **blind to variant and model**, with identifiers stripped and order shuffled. The external rater's labels are primary, and agreement is reported as Cohen's κ.

## Budget estimate (to be replaced by pilot measurements)

Assumptions:
- A B episode is about 8 turns, about 48K input tokens in total (about 80% read from cache), and about 4K output tokens including thinking.
- A C or language call is about 3K input and 0.5K output tokens.

| Item | Episodes | Est. $/episode | Est. total |
| --- | --- | --- | --- |
| Development: Haiku, 4 rungs × R-dev 50 × k=2 × ~10 prompt iterations | ~4,000 | ~0.004 | ~$16 |
| Confirmatory: Haiku, 4 rungs × (R-conf 50 + R-hold 12) × k=5 | 1,240 | ~0.004 | ~$5 |
| Confirmatory: Sonnet, same | 1,240 | ~0.07 | ~$87 |
| C and language set, both models, (50 + 12 + 60) × k=5, batched | 1,220 | ≤0.006 | ~$4 |
| **Subtotal** | | | **~$112** |
| **Hard cap** (subtotal + 50% contingency) | | | **$175** |

**Stop rule:** run the pilot first (R-dev, Haiku, k=2, all rungs) and measure the real cost per episode. If the projected confirmatory cost exceeds the cap, cut in this order:
1. Sonnet runs only rungs B0 and B3, plus C.
2. Sonnet k drops to 3. It never goes lower ([ADR-0006](ADR-0006-enforcement-ladder-and-preregistration.md)).
3. Sonnet is dropped entirely, which is reported as a limitation.

Every cut is logged as a plan deviation.

## Consequences
- The study's claims are about **these two Claude models with this loop**, not about agents in general. The write-up must say so.
- Haiku carries most of the evidence, and its results may be weaker than a frontier model's. That is acceptable, because the research question is enforcement versus instruction, not peak capability. The Sonnet run shows whether the conclusions hold at a stronger tier.
- No sampling control means pass^k and the repetitions carry the stochastic analysis.

## Reversal trigger
- If the pilot shows Haiku can't operate the tools at all (most episodes failing on tool-call format before any business logic), make Sonnet primary and recompute the budget.
- If additional credits become available, add a second provider's model as an extra arm. The plan stays the same.
