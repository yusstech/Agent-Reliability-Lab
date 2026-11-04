# ADR-0001: Compare three execution architectures instead of assuming one

- **Status:** Accepted; amended by [ADR-0006](ADR-0006-enforcement-ladder-and-preregistration.md), which splits variant B into an enforcement ladder B0–B3
- **Date:** 2026-11-02
- **Phase:** 01

## Context
The investigation asks whether an AI assistant can be trusted to *complete* a business operation, not just to understand it ([spec §1, §4](../PROTOTYPE_SPEC.md)). It is tempting to build only the hybrid design, since it sounds the safest, and then report it as the answer.

## Options considered
1. **Build only the hybrid (C).** Least work. But there is no baseline, so the result can't be falsified.
2. **Build the agent-directed (B) and hybrid (C) variants.** This shows model trade-offs, but it can't separate "the model helped" from "the workflow helped".
3. **Build deterministic (A), agent-directed (B) and hybrid (C) on identical mock services and scenarios.** This is the most work, and it gives a fair comparison.

## Decision
Option 3. Variant A is built first and becomes the baseline. B and C reuse the same providers, fixtures, dataset and evaluator.

## Consequences
- Phases 01–04 contain no model code. The shared infrastructure must not encode assumptions that favour any one variant.
- For the reliability study, all variants receive equivalent structured intent. Language understanding is evaluated separately.
- "Hybrid is better" stays a hypothesis until Phase 05 data exists.

## Reversal trigger
If variant B cannot be made to process the dataset under any reasonable tool budget, record that as a finding instead of dropping the variant silently.
