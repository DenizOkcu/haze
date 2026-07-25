# Data Model: /fleet — Parallel Subagent Orchestration

**Branch**: `001-fleet-subagents` | **Date**: 2026-07-09 (revised for native command)

This feature introduces **no new persisted data structures**. `/fleet` is a native command that orchestrates the existing `subagent` tool. The "data model" below documents the **logical/conceptual** entities (from the spec's Key Entities) and maps each to the **existing runtime shape** it reuses. There is no schema to migrate and no storage to add.

---

## Conceptual entities (from spec)

### Fleet Prompt
The user's natural-language instruction, passed as the args to `/fleet <prompt>`.

- **Shape at runtime**: a `string` — the trailing text after `/fleet `, captured by the `exactOrArgs('/fleet')` matcher in `src/cli/commands/commands.ts` as `args` and passed to `handleFleetCommand(args, ctx)`.
- **Validation**: non-empty. An empty/whitespace-only `/fleet` is rejected by `handleFleetCommand` with a usage message and no model turn (no fan-out). No structural validation required.

### Fleet Guidance
The static behavioral instructions the command injects into the turn.

- **Shape at runtime**: the `FLEET_GUIDANCE` compile-time string constant in `src/cli/commands/fleetCommand.ts`. `buildFleetPrompt(args)` returns `${FLEET_GUIDANCE}\n\n---\n\nThe user ran /fleet with the prompt below. Apply the flow above to it.\n\nUser prompt:\n${args}`.
- **State**: none — it is source code, not a runtime artifact or file.

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
   │  (commands.ts exactOrArgs('/fleet') → handleFleetCommand(args, ctx))
   ▼
[Fleet Prompt] ──buildFleetPrompt──▶ [Fleet Guidance + prompt]
   │                                        │
   │   ctx.runAgentTurn(directive, '/fleet <prompt>')  (== doAgentTurn in chat.tsx)
   ▼                                        ▼
   ┌──────────────── model reasons ────────────────▶ [Decomposition]
                                                          │
                                       ┌──────────────────┴──────────────────┐
                                       ▼ not parallelizable                  ▼ parallelizable
                                inform user + STOP              emit one `subagent` tool call
                                (FR-004; no auto-execute)       per Subtask (≤5, disjoint files)
                                                                       │
                                          ┌───────────────────────────────┴───────────────┐
                                          ▼                                                ▼
                                  [Subagent runs]                                  [Subagent runs]
                                  (own context, bounded)                           (own context, bounded)
                                          ▼                                                ▼
                                    [Subtask Result]                                [Subtask Result]
                                                       │
                                      model aggregates ▼
                                      [consolidated answer]  ← also enters conversation (FR-007)
```

Abort: the turn's shared `AbortSignal` propagates to every in-flight `subagent`; each returns `status: 'cancelled'` (FR-008).

---

## Validation rules mapped to existing guarantees

| Spec rule | Existing runtime guarantee | Gap |
|-----------|---------------------------|-----|
| FR-006 cap of 5 | Per-subagent step/tool/token bounds | Soft (model-guided in `FLEET_GUIDANCE`) |
| FR-008 abort all | Shared turn `AbortSignal` → `runSubagent` | Verify + test |
| FR-009 partial failure | Parallel tool errors returned per-call; model continues | Verify + test |
| FR-010 independent context | Each subagent builds its own prompt/context | None |
| FR-012 same-file safety | Within-subagent `inFlightMutationPaths` guard | Cross-subagent = model-guided (deferred) |
| FR-013 per-subtask status | Grouped `subagent` activity rendering | Verify rendering of N parallel calls |

---

## Backward compatibility

No serialized shape changes. No session/settings schema changes. The command adds one entry to the in-memory `SLASH_COMMANDS` table, one row to `COMMAND_HELP_ENTRIES`, and one item to the static autocomplete list — all code, none persisted. The existing `subagent` tool, command dispatcher, skill loader, and `/skills` picker are unchanged.
