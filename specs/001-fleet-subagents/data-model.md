# Data Model: /fleet — Parallel Subagent Orchestration

**Branch**: `001-fleet-subagents` | **Date**: 2026-07-09

This feature introduces **no new persisted data structures**. `/fleet` is a Markdown skill that orchestrates the existing `subagent` tool. The "data model" below documents the **logical/conceptual** entities (from the spec's Key Entities) and maps each to the **existing runtime shape** it reuses. There is no schema to migrate and no storage to add.

---

## Conceptual entities (from spec)

### Fleet Prompt
The user's natural-language instruction, passed as the args to `/fleet <prompt>`.

- **Shape at runtime**: a `string` — the trailing text after `/fleet `, captured by `skillInvocation()` in `src/cli/commands/chat.tsx` as `args` and delivered as the user message for the turn.
- **Validation**: non-empty. Empty/whitespace-only `/fleet` is handled by the skill body instructing the model to ask for a prompt (no fan-out). No structural validation required.

### Decomposition
The model's analysis of a Fleet Prompt: a parallelizable decision plus, when parallelizable, the ordered list of independent subtasks; when not, a reason.

- **Shape at runtime**: **no fixed schema** — it is the model's in-context reasoning, expressed in its answer text ("Here are the N independent subtasks: ..."). Deliberately not a JSON object: decomposition is judgment, surfaced as prose so the user can see the plan (spec FR-005) and rephrase if needed.
- **State**: transient; exists only within the turn.

### Subtask
A single independent unit of work assigned to exactly one subagent.

- **Shape at runtime**: a `task: string` argument to the existing `subagent` tool (see `createSubagentTool` input schema in `src/core/subagent/subagentRunner.ts`). Optionally a restricted `tools` allowlist and `maxSteps`.
- **Relationships**: 1 Decomposition → 0..N Subtasks; 1 Subtask → 1 Subagent → 1 Subtask Result.

### Subtask Result
The outcome of one subtask: status, summary, evidence.

- **Shape at runtime**: the existing `SubagentResult` from `runSubagent`:
  - `status: 'ok' | 'error' | 'timeout' | 'cancelled'`
  - `summary: string` (≤ `MAX_SUMMARY` = 4000 chars)
  - `toolCalls: Array<{name, summary, durationMs}>`
  - `toolCallCount: number`
  - `tokens: {in, out}`
  - `durationMs: number`
  - `error?: string`
- This shape is already public (surfaced via formatters and the `subagent` tool result); `/fleet` consumes it without modification.

---

## Runtime flow (entity lifecycle within one turn)

```text
/fleet <prompt>
   │  (skillInvocation → skill "fleet" + args)
   ▼
[Fleet Prompt] ──model reasons──▶ [Decomposition]
                                      │
                   ┌──────────────────┴──────────────────┐
                   ▼ not parallelizable                  ▼ parallelizable
            inform user + STOP              emit one `subagent` tool call
            (FR-004; no auto-execute)       per Subtask (≤5, disjoint files)
                                                   │
                                      ┌────────────┴────────────┐
                                      ▼                         ▼
                              [Subagent runs]            [Subagent runs]
                              (own context, bounded)     (own context, bounded)
                                      │                         │
                                      ▼                         ▼
                                [Subtask Result]          [Subtask Result]
                                                   │
                                   model aggregates ▼
                                   [consolidated answer]  ← also enters conversation (FR-007)
```

Abort: the turn's shared `AbortSignal` propagates to every in-flight `subagent`; each returns `status: 'cancelled'` (FR-008).

---

## Validation rules mapped to existing guarantees

| Spec rule | Existing runtime guarantee | Gap |
|-----------|---------------------------|-----|
| FR-006 cap of 5 | Per-subagent step/tool/token bounds | Soft (model-guided in skill) |
| FR-008 abort all | Shared turn `AbortSignal` → `runSubagent` | Verify + test |
| FR-009 partial failure | Parallel tool errors returned per-call; model continues | Verify + test |
| FR-010 independent context | Each subagent builds its own prompt/context | None |
| FR-012 same-file safety | Within-subagent `inFlightMutationPaths` guard | Cross-subagent = model-guided (deferred) |
| FR-013 per-subtask status | Grouped `subagent` activity rendering | Verify rendering of N parallel calls |

---

## Backward compatibility

No serialized shape changes. No session/settings/skill-file schema changes. The `examples/skills/fleet/SKILL.md` file conforms to the existing skill frontmatter contract (`name` + non-empty `description`), so the existing `SkillLoader`/`SkillRegistry` load it with no code changes.
