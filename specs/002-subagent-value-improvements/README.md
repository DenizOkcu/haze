# Subagent value improvement dossier

**Review date:** 2026-07-31
**Scope:** the model-facing `subagent` tool, the native `/fleet` command, worker execution, provider/model behavior, terminal feedback, and cloud/local operating characteristics.

This directory is an implementation handoff, not a claim that the work is already shipped.

## Documents

1. [context-isolation-contract.md](./context-isolation-contract.md) — primary product contract for a lightweight spin-off agent: fresh context, shared `AGENTS.md` discovery logic, private intermediate work, and a result-only handoff.
2. [invocation-plan.md](./invocation-plan.md) — how the main LLM chooses direct work vs one subagent vs multiple workers, constructs a compact capsule, and consumes the result.
3. [research.md](./research.md) — evidence-based review of the current implementation, strengths, gaps, and cloud/local implications.
4. [plan.md](./plan.md) — recommended target architecture, staged rollout, and product decisions.
5. [tasks.md](./tasks.md) — implementation-ready task list with tests and acceptance criteria.

## Executive conclusion

The primary subagent value is **context isolation**, not parallelism: spin off a temporary agent with a fresh, lightweight context, let it perform noisy investigation privately, and return only a compact deliverable to the main thread. It must use the same project-instruction precedence and lazy `AGENTS.md`/`CLAUDE.md` discovery logic as the main agent without inheriting the main conversation or unrelated context.

The current runner already starts workers without main-thread chat history, but it still copies the parent's loaded context-file set, uses broad tool defaults, and returns more execution metadata to the parent model than the deliverable requires. `/fleet` adds parallel scheduling on top of this primitive.

The highest-value next step is therefore **not more fleet prompt text**. First establish the lightweight task-capsule → private worker → result-capsule contract. Then add a provider-aware orchestration layer that enforces concurrency and deadlines, supports explicit worker profiles/models, coordinates writes, and keeps observability metadata out of the main model context.

## Recommended delivery order

1. Replace parallel-only invocation guidance with the direct vs one-worker vs multiple-worker decision policy.
2. Implement the task/result capsule and independently assembled lightweight worker context.
3. Correct result semantics and budget inconsistencies.
4. Add hard concurrency/deadline controls and observable worker state.
5. Prevent fleet guidance and worker internals from becoming durable chat history.
6. Add shared workspace mutation coordination and safe read-only review mode.
7. Add explicit cloud/local execution profiles and worker-model selection.
8. Move `/fleet` from prompt-only fan-out to a deterministic plan → schedule → aggregate flow.

Do not attempt every item in one pull request. The phases in [tasks.md](./tasks.md) are intentionally independently releasable.
