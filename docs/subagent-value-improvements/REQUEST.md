# Subagent Value Improvements — Request

**Created:** 2026-07-31T00:00:00Z

## Original request

> analyze thre subagent value improvements and implement all findings

This follows the user's clarification that a subagent's primary value is a disposable spin-off context: it starts with an optimized lightweight prompt, uses the same `AGENTS.md`/`CLAUDE.md` precedence and lazy discovery logic as the main thread, does not inherit the main conversation, keeps intermediate work private, and returns only the end result to the main agent. The user also requested an improved LLM invocation policy based on that goal.

## Source design artifacts

Read all files under `specs/002-subagent-value-improvements/`, especially:

- `context-isolation-contract.md`
- `invocation-plan.md`
- `research.md`
- `plan.md`
- `tasks.md`

These are proposed findings and plans, not proof that every proposal should be implemented unchanged. Reconcile them against current code and project constraints.

## Assumptions

- Implement the complete coherent feature, but prefer a safe integrated architecture over mechanically checking every speculative/optional task.
- Preserve existing explicit provider/model selection; never silently choose another model.
- Preserve compatibility where practical, especially the existing `subagent` tool result and command/session behavior.
- Do not implement remote telemetry or paid-provider CI requirements.
- Optional experimental isolated-worktree workers are not required unless necessary for correctness.
- Generated `dist/` must not be edited.

## Acceptance criteria

1. The main LLM can invoke one subagent for context-heavy independent work, not only two-way parallelism.
2. Worker input is a bounded, clear task capsule and worker context contains no main/sibling conversation history or fleet guidance.
3. Worker project instructions use the same precedence, scoped lazy discovery, and signature logic as the main agent while avoiding unrelated parent context.
4. Worker prompts/tools are lightweight and mode appropriate.
5. Only a compact truthful result capsule enters parent model context; telemetry remains available out of band.
6. Worker outcomes distinguish completion, no output, limits, deadline, cancellation, provider error, and policy block.
7. Provider-specific request options reach workers and worker model selection is explicit if supported.
8. Concurrency and deadlines are hard-enforced by runtime for normal and fleet use.
9. `/fleet` control guidance does not persist in durable conversation/session context.
10. Read-only modes cannot mutate; mutation concurrency and bash behavior are conservatively coordinated.
11. Cloud and local execution profiles are configurable without silent inference/fallback.
12. Tests cover isolation, invocation boundaries, coordinator behavior, persistence, provider settings, status truthfulness, and mutation policy.
13. User-facing help/docs reflect the final behavior.
14. `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`, and `npm pack --dry-run` pass, or remaining environmental blockers are documented.
