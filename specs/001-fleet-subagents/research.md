# Phase 0 Research: /fleet — Parallel Subagent Orchestration

**Branch**: `001-fleet-subagents` | **Date**: 2026-07-09 (revised for native command)

This document resolves every design decision and "unknown" for the `/fleet` feature. Each item records the **Decision**, **Rationale**, and **Alternatives considered**. No `NEEDS CLARIFICATION` markers remain.

> **Revision note.** D1 was originally resolved in favor of a *skill* (constitution Principle II). The project owner later directed a **native command**; D1, D2, and D10 below reflect the current decision, with the original skill rationale preserved as the rejected alternative.

---

## D1. Built-in command vs. skill (the central decision)

**Decision**: `/fleet` is a **native slash command** implemented in `src/cli/commands/fleetCommand.ts`, registered with the other built-ins and listed in `/help` and the `/` autocomplete.

**Rationale**: The project owner requires `/fleet` to be a first-class built-in — discoverable in the native command surface and usable with no install or copy step. A native command is the only way to satisfy that: it is matched by `handleSlashCommand` in `src/cli/commands/commands.ts`, appears in `COMMAND_HELP_ENTRIES` (`commandHelp.ts`), and in the static command list in `src/cli/chat/inputSuggestions.ts`. Skills, by contrast, are user-owned and opt-in (they require an install to `~/.haze/skills/` or creation via `/skills`) and never appear in the built-in command table.

Implementation shape: the command is a *thin guidance-injection wrapper*. `handleFleetCommand(args, ctx)` guards the empty-prompt case, then calls `ctx.runAgentTurn(buildFleetPrompt(args), '/fleet <args>')`. `buildFleetPrompt` concatenates the fleet behavioral guidance (`FLEET_GUIDANCE`) with the user's prompt and returns a single directive string; the rest is a normal model turn. The turn is displayed as `/fleet <args>` (the `displayValue`), not the giant guidance blob.

**Consequence for the constitution**: this is an explicit, owner-approved exception to NON-NEGOTIABLE Principle II ("Minimal Core, Skills as First-Class Tools"), which would otherwise require `/fleet` to be a skill. The mitigation is that the command adds **zero native tools** — it reuses the already-existing `subagent` tool — so Principle II's core concern (native-toolset growth) is not triggered; only the command surface grows by one thin entry. See `plan.md` Constitution Check and Complexity Tracking.

**Alternatives considered**:
- *Shipped example skill* (`examples/skills/fleet/SKILL.md` → `~/.haze/skills/fleet/`). This was the original, constitution-compliant design and was implemented first. Rejected by the owner: skills are opt-in (require install) and do not appear in the built-in command surface. The skill artifacts and the installed copy were removed — critically, an installed `fleet` skill would *shadow* the native command, because `chat.tsx` evaluates `skillInvocation()` before `handleSlashCommand()`.
- *New built-in command + a `core/fleet` orchestration module that hard-implements decomposition/fan-out/aggregation in code.* Rejected: it would reimplement in TypeScript the model-driven judgment (decomposition, aggregation prose) that the model already does in-turn, for no gain, while still depending on the same `subagent` tool. The guidance-injection wrapper gets the same behavior at far lower cost and risk.

---

## D2. How the prompt reaches the model

**Decision**: `/fleet <prompt>` is matched by `exactOrArgs('/fleet')` in the command registry; the trailing text becomes `args`. `handleFleetCommand` calls `ctx.runAgentTurn(buildFleetPrompt(args), '/fleet <args>')`. `runAgentTurn` is wired to `doAgentTurn` in `chat.tsx`, so the fleet guidance + the user's prompt become the turn's user message, and the model follows the guidance using the existing `subagent` tool.

**Rationale**: This mirrors how `/init` works (`handleInitCommand` → `ctx.runAgentTurn(buildInitPrompt(), '/init')`) — an established, low-risk pattern for native commands whose value is steering the model. No new plumbing.

**Alternatives considered**: Delivering the guidance as a system-prompt segment rather than the user message. Rejected for now: there is no per-turn instruction-override hook, and the `/init` precedent (user-message directive) is proven and sufficient.

---

## D3. Parallelizability analysis & decomposition

**Decision**: Analysis and decomposition are **model-driven** by the guidance text. The guidance tells the model to (a) decide whether the prompt decomposes into 2+ genuinely independent tasks, (b) if yes, enumerate the subtasks, (c) if no, inform the user and stop (no auto-execute — see D6).

**Rationale**: Decomposition is inherently a judgment call best made by the model in context. Hardcoding a parser would be brittle and would duplicate reasoning the model already does (the `subagent` tool description already asks it to judge independence).

**Alternatives considered**: A separate structured "decomposition" model call returning JSON. Rejected: adds a round-trip and a schema for no gain — the model can decompose and act in the same turn by emitting one `subagent` tool call per subtask.

---

## D4. Bounded concurrency (the "cap of 5") — FR-006

**Decision**: The cap of 5 concurrent subagents is **model-guided discipline** encoded in `FLEET_GUIDANCE` ("spawn at most 5 subagents in one step; if a prompt yields more independent tasks than 5, prioritize the 5 highest-value and report the remainder"). It is NOT a hard-enforced code limit.

**Rationale**: Model-guidance text cannot enforce a hard cap on tool-call count. The worst case is already bounded: each subagent independently caps its own steps (`STEP_LIMIT=25`), tool-only loops (`TOOL_ONLY_LIMIT=12`), summary length (`MAX_SUMMARY=4000`), and output tokens (`4096`). So even an over-eager fan-out cannot exhaust memory or run unbounded — only spend more tokens, which is a cost concern, not a safety invariant.

**Alternatives considered**: A hard cap in the agent loop / `prepareStep` that rejects `subagent` tool calls beyond N per step. Rejected for now: it is a core change to the agent turn machinery to enforce a *cost preference*, not a memory-safety invariant. Revisit only if real usage shows the model routinely ignoring the soft cap.

---

## D5. Concurrent same-file writes across subagents — FR-012

**Decision**: Cross-subagent same-path edit safety is **model-guided**: the guidance instructs the model to assign each parallel subtask a **disjoint** set of files, and to merge two tasks into one subagent (or run them sequentially) whenever they must touch the same file.

**Rationale**: Code investigation confirmed the existing same-path mutation guard (`runDedupedTool` / `inFlightMutationPaths` in `src/llm/tools/toolContext.ts`) operates **within a single `streamText` run's `HazeToolContext`**. Each subagent creates its **own** `HazeToolContext` (`{inFlightToolCalls: new Map()}` in `subagentRunner.ts`), so the guard catches a subagent clobbering *its own* concurrent edits but does NOT see a *sibling* subagent editing the same path. Hard-enforcing cross-subagent safety would require sharing a write-lock set across independent `streamText` runs — shared mutable state that Principle VI explicitly cautions against. That complexity is not justified while model-guided file-disjointness suffices.

**Alternatives considered**:
- *Shared cross-subagent `inFlightMutationPaths`.* Rejected now (Principle VI complexity). **Deferred**: add only if empirical use shows cross-subagent same-file edits causing data loss. If added, it becomes a justified core safety primitive (Principle III/IV), applied generally to all parallel subagent use — not `/fleet`-specific.
- *Make fleet subagents read-only.* Rejected: the feature's value includes parallel *work* (edits).

---

## D6. Non-parallelizable fallback — FR-004

**Decision**: When the prompt is not parallelizable, the model informs the user (with the reason) and **stops**. It does NOT auto-execute the prompt as a normal turn. The user re-submits via the normal path if they want it run.

**Rationale**: `/fleet` is an explicit opt-in for *parallel* execution; silently running a different kind of turn would violate the command's contract (clarified-spec Q2). The guidance encodes this instruction.

**Alternatives considered**: Auto-fallback to a normal turn. Rejected (clarification Q2) — surprising side effects, muddied contract.

---

## D7. Result aggregation & conversation injection — FR-007

**Decision**: The model aggregates the subagents' returned summaries into a single consolidated answer as part of its normal turn output. Because the answer is the turn's final message, it is **automatically part of the conversation context** for subsequent turns — no special injection code.

**Rationale**: This is how every normal turn works; the guidance just tells the model to produce a consolidated summary across subagent results. Consistent with clarification Q3 (inject into context).

**Alternatives considered**: A separate system message holding the aggregate. Rejected: unnecessary — the assistant's final text already enters the conversation.

---

## D8. Abort behavior — FR-008

**Decision**: Aborting a `/fleet` turn uses the **existing** turn-abort mechanism. The turn's `AbortSignal` is passed to tool execution; the `subagent` tool forwards `context.abortSignal` to `runSubagent`, which returns status `cancelled` on abort. So one user abort stops all in-flight subagents.

**Rationale**: Already wired in core — no new code. Implementation verifies this with a regression test (`tests/core/subagent/subagentRunner.test.ts`) that aborting a turn with in-flight `subagent` calls cancels them and restores control.

**Alternatives considered**: A fleet-specific abort coordinator. Rejected: duplicates existing machinery.

---

## D9. Per-subtask progress visibility — FR-013

**Decision**: Per-subtask status is surfaced via the **existing** compact, grouped tool-activity rendering (formatters already special-case `subagent`: "Running subagent" / `subagent "<task preview>"`). The guidance does NOT request live per-subagent token streaming (clarification Q5: per-subtask status, no live streaming).

**Rationale**: haze already renders in-flight and completed tool calls as grouped activity. Multiple parallel `subagent` calls in one step render as multiple activity rows that update as each finishes — which satisfies "per-subtask status updated as each finishes, no live streaming." No UI change required; verified with a regression test in `tests/cli/formatters.test.ts`.

**Alternatives considered**: A bespoke parallel-progress UI component. Rejected: scope/complexity unjustified; existing activity rendering already conveys running/done/failed per call.

---

## D10. Distribution & availability

**Decision**: `/fleet` is built into the package — present in every install of `@denizokcu/haze` with no setup. There is nothing to copy or enable.

**Rationale**: The owner requirement is zero-step availability and native-surface discoverability. A built-in command is available the moment haze is installed and appears in `/help`.

**Alternatives considered**: Ship as `examples/skills/fleet/SKILL.md` requiring a copy to `~/.haze/skills/fleet/` (the original skill design). Rejected by the owner: opt-in, not in the native command surface, and (if installed) would shadow the native command.

---

## Summary of resolved unknowns

| ID | Topic | Resolution |
|----|-------|-----------|
| D1 | Built-in vs. skill | **Native command** (owner override of original skill decision) |
| D2 | Prompt delivery | Native command handler → `ctx.runAgentTurn(buildFleetPrompt(args))` |
| D3 | Analysis/decomposition | Model-driven via guidance text |
| D4 | Concurrency cap (FR-006) | Soft, model-guided (≤5); per-worker bounds already exist |
| D5 | Cross-subagent same-file writes (FR-012) | Model-guided file-disjointness; hard-enforcement deferred |
| D6 | Non-parallelizable fallback (FR-004) | Inform + stop; no auto-execute |
| D7 | Aggregation/injection (FR-007) | Normal turn final message (auto in context) |
| D8 | Abort (FR-008) | Existing shared turn AbortSignal (verify + test) |
| D9 | Per-subtask progress (FR-013) | Existing grouped tool-activity rendering |
| D10 | Distribution | Built-in command; no install step |

No `NEEDS CLARIFICATION` markers remain.
