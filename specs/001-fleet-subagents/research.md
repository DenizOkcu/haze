# Phase 0 Research: /fleet — Parallel Subagent Orchestration

**Branch**: `001-fleet-subagents` | **Date**: 2026-07-09

This document resolves every design decision and "unknown" for the `/fleet` feature. Each item records the **Decision**, **Rationale**, and **Alternatives considered**. No `NEEDS CLARIFICATION` markers remain.

---

## D1. Built-in command vs. skill (the central decision)

**Decision**: `/fleet` is a **shipped example skill** (`examples/skills/fleet/SKILL.md`, installable to `~/.haze/skills/fleet/`), not a built-in slash command.

**Rationale**: The constitution's NON-NEGOTIABLE Principle II ("Minimal Core, Skills as First-Class Tools") states that new workflow/ritual capability MUST be added as a user-created skill, not a built-in feature, and that native-toolset growth must be justified, not incidental. `/fleet` (analyze → decide → fan out → aggregate → decline-if-not-parallel) is precisely workflow/ritual capability layered on top of an *already-existing* capability.

Verification of feasibility (from the codebase):
- The model already has a `subagent` tool (`createSubagentTool` in `src/core/subagent/subagentRunner.ts`, registered under category `'subagent'` in `src/llm/requestContext.ts`). Its description already tells the model to spawn subagents "in parallel" for "2+ independent subtasks." So the fan-out primitive already exists and is model-controllable.
- A skill named `fleet` is automatically invocable as `/fleet <args>`: `skillInvocation()` in `src/cli/commands/chat.tsx` matches `/<skillName>` and passes the trailing text as args; disabled skills are excluded. This gives the exact UX the user asked for ("a slash command /fleet").
- The skill is discoverable as a first-class peer via the single `skill` catalog tool (`src/skills/skillTools.ts`) and managed via the `/skills` picker — exactly the "peer-to-native-tools" contract in Principle II.

**Alternatives considered**:
- *New built-in slash command in `src/cli/commands/commands.ts` + a `core/fleet` orchestration module.* Rejected: it grows the native surface for a workflow that the existing `subagent` tool already supports, violating Principle II without the justification threshold (a hard safety/correctness invariant that only code can enforce — see D4/D5).
- *Hybrid: skill + new core primitives.* Rejected for now (see D4, D5): the needed primitives either already exist or can be model-guided; adding shared cross-subagent state conflicts with Principle VI's spirit and isn't justified yet.

---

## D2. How the prompt reaches the model

**Decision**: `/fleet <prompt>` → `skillInvocation()` returns `{skill: fleet, args: "<prompt>"}`. The fleet skill body is loaded as turn instructions; the user message carries the prompt text. The model reads the prompt and follows the skill.

**Rationale**: This is the existing skill-invocation contract; no new plumbing. The skill body instructs the model how to treat the prompt (analyze for parallelism, etc.).

**Alternatives considered**: None viable — this is the only path consistent with the skill contract.

---

## D3. Parallelizability analysis & decomposition

**Decision**: Analysis and decomposition are **model-driven** by the skill instructions. The skill tells the model to (a) decide whether the prompt decomposes into 2+ genuinely independent tasks, (b) if yes, enumerate the subtasks, (c) if no, inform the user and stop (no auto-execute — see D6).

**Rationale**: Decomposition is inherently a judgment call best made by the model in context. Hardcoding a parser would be brittle and would duplicate reasoning the model already does (the `subagent` tool description already asks it to judge independence). Per the constitution, skills are "instructions only"; model-driven judgment is the intended mechanism.

**Alternatives considered**: A separate structured "decomposition" model call returning JSON. Rejected: adds a round-trip and a schema for no gain — the model can decompose and act in the same turn by emitting one `subagent` tool call per subtask.

---

## D4. Bounded concurrency (the "cap of 5") — FR-006

**Decision**: The cap of 5 concurrent subagents is **model-guided discipline** encoded in the skill body ("spawn at most 5 subagents in one step; if a prompt yields more independent tasks than 5, prioritize the 5 highest-value and report the remainder, or batch them after the first wave completes"). It is NOT a hard-enforced code limit.

**Rationale**: A Markdown skill cannot enforce a hard cap on tool-call count (skills don't execute code). The constitution mandates the skill approach (Principle II), so the cap is soft. The worst case is already bounded: each subagent independently caps its own steps (`STEP_LIMIT=25`), tool-only loops (`TOOL_ONLY_LIMIT=12`), summary length (`MAX_SUMMARY=4000`), and output tokens (`4096`). So even an over-eager fan-out cannot exhaust memory or run unbounded — only spend more tokens, which is a cost concern, not a safety invariant.

**Alternatives considered**: A hard cap in the agent loop / `prepareStep` that rejects `subagent` tool calls beyond N per step. Rejected for now: it is a core change to the agent turn machinery to enforce a *cost preference*, not a memory-safety invariant (Principle III concerns byte/work budgets on collectors, not spawn counts). Revisit only if real usage shows the model routinely ignoring the soft cap.

---

## D5. Concurrent same-file writes across subagents — FR-012

**Decision**: Cross-subagent same-path edit safety is **model-guided**: the skill instructs the model to assign each parallel subtask a **disjoint** set of files, and to merge two tasks into one subagent (or run them sequentially) whenever they must touch the same file.

**Rationale**: Code investigation confirmed the existing same-path mutation guard (`runDedupedTool` / `inFlightMutationPaths` in `src/llm/tools/toolContext.ts`) operates **within a single `streamText` run's `HazeToolContext`**. Each subagent creates its **own** `HazeToolContext` (`{inFlightToolCalls: new Map()}` in `subagentRunner.ts`), so the guard catches a subagent clobbering *its own* concurrent edits but does NOT see a *sibling* subagent editing the same path. Hard-enforcing cross-subagent safety would require sharing a write-lock set across independent `streamText` runs — shared mutable state that Principle VI explicitly cautions against (and would need reset/clear helpers + tests). That complexity is not justified while model-guided file-disjointness suffices, and the failure mode (two independent tasks both rewriting the same file) is rare for genuinely-independent tasks.

**Alternatives considered**:
- *Shared cross-subagent `inFlightMutationPaths`.* Rejected now (Principle VI complexity; see above). **Deferred**: add only if empirical use shows cross-subagent same-file edits occurring and causing data loss. If added, it becomes a justified core safety primitive (Principle III/IV), applied generally to all parallel subagent use — not `/fleet`-specific.
- *Make fleet subagents read-only.* Rejected: the feature's value includes parallel *work* (edits), and the user's intent ("starts subagents for each parallelizable task") implies tasks may modify files.

---

## D6. Non-parallelizable fallback — FR-004

**Decision**: When the prompt is not parallelizable, the model informs the user (with the reason) and **stops**. It does NOT auto-execute the prompt as a normal turn. The user re-submits via the normal path if they want it run.

**Rationale**: `/fleet` is an explicit opt-in for *parallel* execution; silently running a different kind of turn would violate the command's contract. This is the clarified-spec decision (clarification session Q2). The skill encodes this instruction.

**Alternatives considered**: Auto-fallback to a normal turn. Rejected (clarification Q2) — surprising side effects, muddied contract.

---

## D7. Result aggregation & conversation injection — FR-007

**Decision**: The model aggregates the subagents' returned summaries into a single consolidated answer as part of its normal turn output. Because the answer is the turn's final message, it is **automatically part of the conversation context** for subsequent turns — no special injection code.

**Rationale**: This is how every normal turn works; the skill just instructs the model to produce a consolidated summary across subagent results. Consistent with clarification Q3 (inject into context).

**Alternatives considered**: A separate system message holding the aggregate. Rejected: unnecessary — the assistant's final text already enters the conversation.

---

## D8. Abort behavior — FR-008

**Decision**: Aborting a `/fleet` turn uses the **existing** turn-abort mechanism. The turn's `AbortSignal` is passed to tool execution; the `subagent` tool forwards `context.abortSignal` to `runSubagent`, which returns status `cancelled` on abort. So one user abort stops all in-flight subagents.

**Rationale**: Already wired in core — no new code. Implementation only needs to **verify and add a regression test** that aborting a turn with in-flight `subagent` calls cancels them and restores control.

**Alternatives considered**: A fleet-specific abort coordinator. Rejected: duplicates existing machinery.

---

## D9. Per-subtask progress visibility — FR-013

**Decision**: Per-subtask status is surfaced via the **existing** compact, grouped tool-activity rendering (formatters already special-case `subagent`: "Running subagent" / `subagent "<task preview>"`). The skill does NOT request live per-subagent token streaming (clarification Q5: per-subtask status, no live streaming).

**Rationale**: haze already renders in-flight and completed tool calls as grouped activity. Multiple parallel `subagent` calls in one step render as multiple activity rows that update as each finishes — which satisfies "per-subtask status updated as each finishes, no live streaming." No UI change required; verify rendering with N parallel subagents during implementation.

**Alternatives considered**: A bespoke parallel-progress UI component. Rejected: scope/complexity unjustified; existing activity rendering already conveys running/done/failed per call.

---

## D10. Distribution & installation path

**Decision**: Ship as `examples/skills/fleet/SKILL.md`. Users install by copying `examples/skills/fleet/` into `~/.haze/skills/fleet/` (or via the `/skills` "add skill" flow pointing at the example, or by authoring from a description). Once installed and enabled, `/fleet` is available.

**Rationale**: This is haze's standard skill distribution pattern (`examples/skills/files/` is the existing precedent). Keeps the skill out of the user's home dir by default (private-by-default, Principle VIII) while making it trivially installable.

**Alternatives considered**: Auto-install into `~/.haze/skills/` at first run. Rejected: surprising home-directory writes; skills are user-owned and opt-in.

---

## Summary of resolved unknowns

| ID | Topic | Resolution |
|----|-------|-----------|
| D1 | Built-in vs. skill | **Skill** (Principle II) |
| D2 | Prompt delivery | Existing `/skill args` invocation contract |
| D3 | Analysis/decomposition | Model-driven via skill body |
| D4 | Concurrency cap (FR-006) | Soft, model-guided (≤5); per-worker bounds already exist |
| D5 | Cross-subagent same-file writes (FR-012) | Model-guided file-disjointness; hard-enforcement deferred |
| D6 | Non-parallelizable fallback (FR-004) | Inform + stop; no auto-execute |
| D7 | Aggregation/injection (FR-007) | Normal turn final message (auto in context) |
| D8 | Abort (FR-008) | Existing shared turn AbortSignal (verify + test) |
| D9 | Per-subtask progress (FR-013) | Existing grouped tool-activity rendering |
| D10 | Distribution | `examples/skills/fleet/SKILL.md` |

No `NEEDS CLARIFICATION` markers remain.
