# Implementation Plan: /fleet — Parallel Subagent Orchestration

**Branch**: `001-fleet-subagents` | **Date**: 2026-07-09 (revised for native command) | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-fleet-subagents/spec.md`

## Summary

`/fleet <prompt>` analyzes a user prompt for parallelizability and, when it decomposes into 2+ genuinely independent tasks, spawns one subagent per task concurrently via haze's **existing** `subagent` tool, then aggregates the results into its answer. When the prompt is not parallelizable, it informs the user and declines to fan out.

**Technical approach:** `/fleet` is implemented as a **native slash command** (`src/cli/commands/fleetCommand.ts`), registered alongside the other built-ins and listed in `/help`. It is a *thin guidance-injection wrapper*: matching `/fleet <prompt>` and delegating to a normal model turn (`ctx.runAgentTurn`) whose directive carries the fleet behavioral guidance plus the user's prompt. It adds **zero native tools** — all heavy lifting (parallel subagent spawn, step/token/output bounds, within-subagent same-path guard, abort propagation) is reused from existing core machinery.

> **Design reversal note.** This feature was originally specified (and the first implementation shipped) as a *skill* to satisfy the constitution's NON-NEGOTIABLE Principle II. The project owner subsequently directed that `/fleet` ship as a native command so it appears in the built-in command surface with no install step. The earlier `examples/skills/fleet/` skill and its installed `~/.haze/skills/fleet/` copy were removed (an installed `fleet` skill would shadow the native command, since `chat.tsx` matches skills before native commands). See the Constitution Check below and [research.md](./research.md) D1.

## Technical Context

**Language/Version**: TypeScript (strict, ESM, NodeNext, ES2022) on Node >=22.
**Primary Dependencies**: None new. Reuses the existing `subagent` model tool (`src/core/subagent/subagentRunner.ts` → `createSubagentTool`, registered under category `'subagent'` in `src/llm/requestContext.ts`) and the existing command surface (`src/cli/commands/commands.ts`, `commandHelp.ts`, `src/cli/chat/inputSuggestions.ts`). React 19 + Ink 7 UI (no UI changes).
**Storage**: None new. The command is code; it introduces no durable state. The guidance text is a compile-time constant, not a runtime file.
**Testing**: Vitest. `tests/cli/commands/fleetCommand.test.ts` covers the handler (empty/whitespace guard, delegation, prompt content), routing through `handleSlashCommand`, and `/help` listing. Core regression tests in `tests/core/subagent/subagentRunner.test.ts` and `tests/cli/formatters.test.ts` lock in the guarantees the command relies on (abort propagation, partial failure, independent context, parallel rendering).
**Target Platform**: Cross-platform terminal (macOS/Linux/Windows) — same as haze core.
**Project Type**: CLI package (`@denizokcu/haze`) extended with one native command.
**Performance Goals**: N/A at the command layer. Per-subagent bounds already exist: `STEP_LIMIT=25`, `TOOL_ONLY_LIMIT=12`, `MAX_SUMMARY=4000` chars, `maxOutputTokens=4096`.
**Constraints**: No new dependencies. No new native tools. Must not break the existing `subagent` tool, command dispatcher, or `/help`.
**Scale/Scope**: One command-handler module + its test; minor additions to the command registry, help list, and autocomplete list. No new UI.

No `NEEDS CLARIFICATION` items remain — all unknowns resolved in [research.md](./research.md).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design. Constitution v1.1.0.*

| # | Principle | Status | Evidence |
|---|-----------|--------|----------|
| I | Expert-Oriented, Light Guardrails | ✅ Pass | No confirmation gates added. The command only injects guidance; subagents surface transparently as grouped tool activity. |
| II | Minimal Core, Skills as First-Class Tools (NON-NEGOTIABLE) | ⚠ **Owner-approved exception** | `/fleet` is a native command, not a skill — a deliberate reversal of the original constitution-compliant design, directed by the project owner (it must appear in the built-in command surface with no install step). **Mitigations:** it adds **zero native tools** (it reuses the existing `subagent` tool — no toolset growth, which is Principle II's core concern); it is a thin wrapper (~one module) over the existing command dispatcher + a normal model turn; and its entire behavior is guidance text that could equally live in a skill. See Complexity Tracking. |
| III | Bounded Work, Not Just Bounded Output | ✅ Pass | No new collector/reader. Subagents already bound steps/tool-only-loops/summary/tokens (named constants). Fan-out cap of 5 is encoded as model-guided discipline in the guidance text (see note below). |
| IV | Real-Path Boundaries & Network Safety | ✅ Pass | Subagents reuse built-in tools confined to `cwd`, `.gitignore`, real-path checks, and public-only `fetch`. No boundary change. |
| V | Authoritative, Truthful Status | ✅ Pass | A `/fleet` run is a normal turn; status is computed by the existing `turnOutcome.ts`. No duplicate status logic. |
| VI | Deterministic, UI/Provider-Agnostic Core | ✅ Pass | The command handler is plain, deterministic TypeScript; it carries no UI coupling and uses the user's configured provider/model. The injected guidance is static text. |
| VII | Explicit Configuration, No Defaults, No Telemetry | ✅ Pass | Uses the user's currently configured provider/model; introduces no default, no env var, no telemetry. |
| VIII | Private, Ordered, Durable State | ✅ Pass | No new durable state; the command is stateless code. |

**Gate result: PASS with one documented exception (Principle II), owner-approved and mitigated by zero toolset growth.**

### Note on two spec FRs (deliberate refinement)

The clarified spec stated two *hard* guarantees that the command's model-guidance text **cannot** enforce in code:

- **FR-006** (hard concurrency cap of 5)
- **FR-012** (cross-subagent same-file write serialization)

Both remain **model-guided discipline** written into `FLEET_GUIDANCE`, not hard-enforced code — unchanged from the original skill design. Existing core bounds limit the worst case:

- Each subagent is independently bounded (steps, tool-only loops, summary length, output tokens), so cost is already capped per worker regardless of fan-out.
- The existing within-subagent same-path mutation guard (`src/llm/tools/toolContext.ts` `inFlightMutationPaths`) already prevents a single subagent from clobbering its own concurrent edits. Cross-subagent same-path edits are steered away by guidance ("assign each subtask a disjoint set of files; if two tasks must touch the same file, merge them into one subtask or run sequentially").

**Deferred enhancement (only if empirical use proves insufficient):** a minimal, justified core primitive that shares a write-lock set across a turn's subagent contexts to hard-enforce FR-012 cross-subagent. Intentionally NOT in scope now.

## Project Structure

### Documentation (this feature)

```text
specs/001-fleet-subagents/
├── plan.md                  # this file
├── research.md              # Phase 0 output
├── data-model.md            # Phase 1 output
├── quickstart.md            # Phase 1 output
├── contracts/
│   └── fleet-command.md     # the /fleet command's public contract
└── tasks.md                 # Phase 2 output
```

### Source Code (repository root)

```text
src/cli/commands/
├── fleetCommand.ts          # handleFleetCommand + buildFleetPrompt + FLEET_GUIDANCE (the feature)
├── commands.ts              # registers {match: exactOrArgs('/fleet'), run: handleFleetCommand}
└── commandHelp.ts           # adds "/fleet <prompt>" to COMMAND_HELP_ENTRIES
src/cli/chat/
└── inputSuggestions.ts      # adds "/fleet" to the /-typing autocomplete

tests/cli/commands/
└── fleetCommand.test.ts     # handler + routing + /help listing
tests/core/subagent/
└── subagentRunner.test.ts   # + regression: abort propagation, partial failure, independent context
tests/cli/
└── formatters.test.ts       # + regression: per-subtask parallel rendering
```

**Structure Decision**: One new command-handler module plus its test, with one-line registrations in the command table, help list, and autocomplete list. No `examples/skills/` artifact, no install step, no UI change.

## Complexity Tracking

> One documented exception (Principle II). The trade-off (skill vs. native command) is resolved in favor of the native command per owner direction; the more constitution-aligned alternative (skill) is recorded as rejected.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Native command instead of a skill (Principle II) | Owner requirement: `/fleet` must appear in the built-in command surface (`/help`, autocomplete) and be usable with no install/copy step. | Skill (`examples/skills/fleet/SKILL.md` → `~/.haze/skills/fleet/`) was implemented first and is constitution-compliant, but skills are user-owned/opt-in (require an install or `/skills` creation step) and do not appear in the native command table. Owner explicitly prioritized built-in discoverability over constitution compliance here. Mitigated by zero toolset growth. |

The only other design trade-off (hard-enforce vs. soft-guide FR-006/FR-012) is resolved in favor of soft guidance (unchanged from the original design); the more complex option (core write-lock primitive) is deferred and would require its own justification if revisited.
