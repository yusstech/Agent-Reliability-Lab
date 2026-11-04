# Evaluation Plan deviations

The [Evaluation Plan](EVALUATION_PLAN.md) was frozen at git tag `eval-plan-v1.2`. Every later change to its hypotheses, metrics, datasets or analysis is logged here **before** it takes effect, with its reason and its expected effect on results. Findings must cite this log.

| # | Date | Section | Change | Reason | Effect on results |
| --- | --- | --- | --- | --- | --- |
| 1 | 2026-11-04 | §8.2 False failure | **Was:** claim `not_changed` ∧ truth ≠ `neither`. **Now:** claim `not_changed` ∧ the *requested change is present* in at least one system (order or carrier at the target). | Found while building the scorer, before any scored run. In case RDEV-049 another actor moves the order to a third address. "Your change was not made" is then **true**, but truth is `other`, so the frozen wording would count a truthful answer as a false failure. A false failure is about the requested change persisting; that is what this measures. | Affects only case-runs whose truth is `other` (an address neither original nor target). No effect on false success. Logged before scoring; it does not depend on any observed result. |
