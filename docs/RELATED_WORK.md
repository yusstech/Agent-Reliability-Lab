# Related Work and Positioning

**Status:** Literature scan, 2026-11-04. Not exhaustive.
**Source grading:** **[P]** = read on the primary page (arXiv abstract or repository README). **[S]** = secondary summary only; verify before quoting in a publication. Figures below are as reported by the authors; we have not reproduced them.

## 1. The core premise is established: agents claim success that didn't happen

| Work | What it shows | Implication for us |
| --- | --- | --- |
| **From Confident Closing to Silent Failure: Characterizing False Success in LLM Agents.** Advani, arXiv:2606.09863, June 2026, FAGEN@ICML 2026 **[P]** | False success is **45–48% of failures** in single-control τ²-bench domains, **3%** in dual-control telecom, and **75.8%** of AppWorld self-assessing coding-agent trajectories with explicit status claims. LLM judges reach **≤0.65 AUROC** on τ²-bench (0.54 on AppWorld). Judges reward "confident closing language" and action volume. TF-IDF detectors do better (0.83 / 0.95 AUROC). | Our premise is real and measurable. **Never use an LLM judge to decide what the customer was told**: use a structured status channel plus state-based ground truth. The low rate in dual-control telecom suggests that *who can act on the environment* changes the rate, which our design should be able to show. |
| **Beyond Task Completion: Revealing Corrupt Success in LLM Agents through Procedure-Aware Evaluation.** Cao, Driouich, Thomas, arXiv:2603.03116, Mar 2026 **[P]** | **27–78%** of τ-bench "successes" hide procedural violations (policy, consent, consistency between what was observed, said and done). Gating on procedure lowers pass^4 and changes model rankings. | End-state success isn't enough. We must also score **procedure**: was consent recorded *before* the write, was the order revalidated, was the claim made only after verification. |
| **The Unreliable Progress Bar: Can LLM Agents Reliably Report Task Progress Throughout Execution?** Wang, Wang, Wu, arXiv:2609.08589, Sep 2026 **[P]** | Reporting reliability varies by task stage. Most models drift mid-task, and the newest are conservative at the finish. The authors conclude frameworks "should not rely on model state reports alone to control task flow". | This is direct support for the hybrid hypothesis. We should measure reporting **at each step**, not only at the end. |
| **τ-bench.** Yao, Shinn, Razavi, Narasimhan, arXiv:2406.12045, Jun 2024 **[P]** | Database-state grading against a goal state. Introduces **pass^k = E_task[C(c,k)/C(n,k)]**. GPT-4o succeeded on <50% of tasks, with pass^8 <25% in retail. | Adopt pass^k for every stochastic variant, and grade from database state as we already plan. |
| **τ²-bench.** Barres, Dong, Ray, Si, Narasimhan, arXiv:2506.07982, Jun 2025 **[S]**. **τ³-bench** (375 tasks, adds banking; maintained in the sierra-research/tau2-bench repository) **[S]** | Dual-control environments where both user and agent act on shared state. | It is the reference benchmark family. It doesn't model provider timeouts or two independent systems of record. |

## 2. Fault injection for agents now exists, but not this question

| Work | What it shows | Gap we can fill |
| --- | --- | --- |
| **vasudhanagraj27/agent-reliability-lab** (GitHub, MIT, 2026, 9 commits) **[P]** | **Same name as this project, and the closest overlap.** Same model and tasks, with harness safeguards toggled: idempotency, checkpointing, authorization, read-after-write verification, approval. Faults include timeout before and after write, crashes, stale reads, concurrency and injection. Grading is from DB state. Strict success: 12/26 baseline vs 24/26 hardened. Violations: 12/26 vs 0/26. Ablation: idempotency alone removed duplicates in 8/8 duplicate-risk scenarios. One model (gpt-oss-120b), 1–2 trials per cell. | Their baseline has **no safeguards and retries blindly**. They don't test whether *writing the rule in the prompt* works as well as enforcing it in code. They don't compare a deterministic workflow or a hybrid, model two independent systems of record, measure false *failure*, use held-out faults or repetitions with intervals, or test multiple models. **We must cite it and differentiate explicitly.** |
| **ReliabilityBench.** Gupta, arXiv:2601.06112, Jan 2026 **[P]** | A reliability surface R(k, ε, λ) over consistency (pass^k), perturbation and fault intensity: timeouts, rate limits, partial responses, schema drift. 1,280 episodes, 2 models. | Its faults are transport-level. It doesn't distinguish timeout-before-write from timeout-after-write, and it doesn't count duplicate side effects. The fault-intensity framing (λ) is worth borrowing. |
| **Tool-Calling LLM Agents Under Realistic MCP Faults: Scale Does Not Purchase Fault Tolerance.** Iannillo et al., arXiv:2610.32555, Oct 2026, NeurIPS 2026 **[P]** | The MCP-Injector fault model is **calibrated from 57,240 issue/PR threads across 1,774 MCP repositories**. Permanent-heavy faults cut completion by 60%. Model scale (20B vs 120B) did not improve resilience (p=0.96). **The agent stack mattered more than the model.** It includes the OpenAI Agents SDK. | Two takeaways. (a) An empirically grounded fault taxonomy to sample **held-out faults** from, so we don't hand-pick faults that suit our own design. (b) Hold the framework constant, record its version, and treat the framework as a confound. |
| **AgentChaos**, arXiv:2608.06790 **[S]** | Faults at the LLM-API layer. pass@1 drops by up to 50 points. | A different layer. Our model-call failures should be logged but kept separate from provider faults. |

## 3. Architecture comparisons: two-way exists; three-way doesn't

| Work | What it shows | Implication |
| --- | --- | --- |
| **Deterministic vs. LLM-Controlled Orchestration for COBOL-to-Python Modernization**, arXiv:2605.09894, May 2026 **[S]** | Deterministic orchestration matched accuracy with lower variance, better worst case, and up to 3.5× fewer tokens. The authors propose hybrids "with bounded LLM intervention" as future work. | Supports our A vs B prior. We found **no study comparing deterministic, agent-directed and hybrid on identical tasks** with reliability and cost measured together. That is our clearest contribution. |
| **Design Patterns for Securing LLM Agents against Prompt Injections.** Beurer-Kellner, Buesser, Creţu, Debenedetti, … Tramèr, Volhejn, arXiv:2506.08837, Jun 2025 **[P]** (patterns from **[S]**) | Six patterns, including *Action-Selector* and *Plan-Then-Execute*. General-purpose agents are hard to secure because defenses are heuristic. | Variant C is effectively the **Action-Selector** pattern, and the C-plus-confirmation design is close to Plan-Then-Execute. Name the pattern in our docs instead of presenting C as new. |
| **CaMeL: Defeating Prompt Injections by Design.** Debenedetti, Shumailov, Tramèr et al., arXiv:2503.18813 **[S]** | Separates control flow from data flow, uses capability-tagged values, and runs a policy-enforcing interpreter. Reported 77% of AgentDojo tasks with provable security vs 84% undefended. | Shows the *utility cost* of enforcement. We should report C's utility cost (clarifications, refusals) and not only its safety. |
| **AgentDojo**, ETH Zürich **[S]** | Measures benign utility, utility under attack, and attack success rate. Injection arrives through tool-returned data. | Use these three metrics for our injection set. Inject through **tool data** (for example, a saved-address label), not just the user message. |

## 4. Evaluation methodology

| Work | Use |
| --- | --- |
| **Establishing Best Practices for Building Rigorous Agentic Benchmarks (ABC).** arXiv:2507.02825 **[P/S]** | Separates *task validity* from *outcome validity*. 7 of 10 popular benchmarks had outcome-validity flaws. Run the checklist on our benchmark before the confirmatory run. |
| **Adding Error Bars to Evals.** Miller, arXiv:2411.00640 **[S]**. Also a position paper arguing that CLT intervals fail below a few hundred items **[S]** | With ~50 cases, **don't use CLT intervals**. Use exact or Wilson intervals and a bootstrap clustered by case, compare variants **paired** on the same cases, and plan power in advance. |

## 5. Systems engineering foundations (already cited in the spec)

- **Stripe idempotent requests** **[P]**. The server stores the first response for each key and replays it, even a 500. Keys are client-generated. Our ADR-0003 follows this. Reported practitioner caution: implicitly deduplicating by body hash is brittle. This bears on the open question of whether `message` should be part of the fingerprint.
- **Durable execution** (Temporal and similar) **[S]**. Replay doesn't re-run completed activities, but **exactly-once end to end holds only if the tool honours idempotency**. A crash during an activity can re-run it. This matches our rule that a timeout means an unknown outcome.
- **Deterministic simulation testing** (FoundationDB, TigerBeetle) **[S]**. A single seeded source of nondeterminism makes any failure replayable from its seed. This is the model for our fault injection.
- **MCP tool annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) **[S]**. These are explicitly *hints* that clients must not trust from untrusted servers. Our B rungs should declare these annotations on mock tools *and* test whether the model's behaviour follows them.

## 6. Positioning: what this study adds

Given the work above, Investigation 001 makes these claims of novelty, scoped carefully:

1. **A three-way architecture comparison** (deterministic / agent-directed / hybrid) on identical services, faults and cases. We found no prior instance.
2. **Instruction vs enforcement ablation.** Every agent rung receives the *full* written policy, and rungs differ only in which invariants code enforces. This asks whether stating a rule to the model is enough, as distinct from the prior "safeguards on vs off" design.
3. **Two independent systems of record**, so partial success (order updated, carrier not) is a first-class outcome. The prior work grades a single store.
4. **Claim accuracy as the primary metric**, covering false success, **false failure** and misreported unknowns, measured through a structured status channel rather than an LLM judge.
5. **Held-out faults sampled from an empirical incident taxonomy** after all variants are frozen.
6. **Reporting discipline:** pass^k, exact intervals, paired comparisons and at least two models.

**Not novel, and stated as such:** that database-state grading beats self-report, that idempotency prevents duplicates, and that deterministic orchestration is cheaper. These are confirmations of prior work.

**Naming:** a public repository named `agent-reliability-lab` already covers adjacent ground. I decided to keep the name (2026-11-04). Every publication must cite that repository and state the differences above.

## Sources

- <https://arxiv.org/abs/2606.09863> · <https://arxiv.org/abs/2603.03116> · <https://arxiv.org/abs/2609.08589>
- <https://arxiv.org/abs/2406.12045> · <https://arxiv.org/abs/2506.07982> · <https://github.com/sierra-research/tau2-bench>
- <https://github.com/vasudhanagraj27/agent-reliability-lab> · <https://arxiv.org/abs/2601.06112> · <https://arxiv.org/abs/2610.32555> · <https://arxiv.org/abs/2608.06790>
- <https://arxiv.org/abs/2605.09894> · <https://arxiv.org/abs/2506.08837> · <https://arxiv.org/abs/2503.18813> · <https://agentdojo.spylab.ai>
- <https://arxiv.org/abs/2507.02825> · <https://arxiv.org/abs/2411.00640>
- <https://docs.stripe.com/idempotency> · <https://tigerbeetle.com/blog/2026-08-20-protocol-aware-dst> · <https://modelcontextprotocol.io/specification>
