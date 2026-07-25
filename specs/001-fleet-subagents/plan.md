# Implementation Plan: /fleet — Parallel Subagent Orchestration

**Branch**: `001-fleet-subagents` | **Date**: 2026-07-09 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-fleet-subagents/spec.md`

## Summary

`/fleet <prompt>` analyzes a user prompt for parallelizability and, when it decomposes into 2+ genuinely independent tasks, spawns one subagent per task concurrently via haze's **existing** `subagent` tool, then aggregates the results into its answer. When the prompt is not parallelizable, it informs the user and declines to fan out.

**Technical approach (constitution-driven):** `/fleet` is implemented as a **shipped example skill** (`examples/skills/fleet/SKILL.md`, installable to `~/.haze/skills/fleet/`), NOT a built-in command. This is mandated by the constitution's NON-NEGOTIABLE Principle II (Minimal Core, Skills as First-Class Tools): `/fleet` is workflow/ritual capability, so it must be a skill. A skill named `fleet` is automatically a first-class `/fleet` slash command and a `skill`-catalog peer — the exact UX requested — with **zero native-toolset growth**. All heavy lifting (parallel subagent spawn, step/token/output bounds, same-path mutation guard, abort propagation) is reused from existing core machinery.

## Technical Context

**Language/Version**: TypeScript (strict, ESM, NodeNext, ES2022) on Node >=22 — for the skill *loader/registry* context only; the skill itself is Markdown.
**Primary Dependencies**: None new. Reuses the existing `subagent` model tool (`src/core/subagent/subagentRunner.ts` → `createSubagentTool`, exposed via `src/llm/requestContext.ts`), the skill system (`src/skills/**`), and React 19 + Ink 7 UI (no UI changes).
**Storage**: None new. The skill is a read-only Markdown file under `~/.haze/skills/fleet/SKILL.md` (and shipped at `examples/skills/fleet/SKILL.md`). No durable state is introduced by this feature.
**Testing**: Vitest. Existing `tests/skills/**` cover skill frontmatter validation, registry loading, and the `skill` catalog tool. Add a smoke test asserting `examples/skills/fleet/SKILL.md` validates and loads.
**Target Platform**: Cross-platform terminal (macOS/Linux/Windows) — same as haze core.
**Project Type**: CLI package (`@denizokcu/haze`) extended via a Markdown skill.
**Performance Goals**: N/A at the skill layer. Per-subagent bounds already exist: `STEP_LIMIT=25`, `TOOL_ONLY_LIMIT=12`, `MAX_SUMMARY=4000` chars, `maxOutputTokens=4096`.
**Constraints**: No new dependencies. No core source changes (zero `src/` diff for the skill itself). Must not break the existing `subagent` tool, skill loader, or `/skills` picker.
**Scale/Scope**: One Markdown skill file + optional reference file(s); one example-skill validation test.

No `NEEDS CLARIFICATION` items remain — all unknowns resolved in [research.md](./research.md).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design. Constitution v1.1.0.*

| # | Principle | Status | Evidence |
|---|-----------|--------|----------|
| I | Expert-Oriented, Light Guardrails | ✅ Pass | No confirmation gates added. The skill is instructions only; subagents surface transparently as grouped tool activity. |
| II | Minimal Core, Skills as First-Class Tools (NON-NEGOTIABLE) | ✅ Pass | **`/fleet` IS a skill** — first-class peer, invocable as `/fleet`, discoverable via the `skill` catalog. Zero native-toolset growth. This is the canonical compliant path. |
| III | Bounded Work, Not Just Bounded Output | ✅ Pass | No new collector/reader. Subagents already bound steps/tool-only-loops/summary/tokens (named constants). Fan-out cap of 5 is encoded as model-guided discipline in the skill body (see note below). |
| IV | Real-Path Boundaries & Network Safety | ✅ Pass | Subagents reuse built-in tools confined to `cwd`, `.gitignore`, real-path checks, and public-only `fetch`. No boundary change. |
| V | Authoritative, Truthful Status | ✅ Pass | A `/fleet` run is a normal turn; status is computed by the existing `turnOutcome.ts`. No duplicate status logic. |
| VI | Deterministic, UI/Provider-Agnostic Core | ✅ Pass | No `src/` changes; the skill is Markdown. Nothing to make non-deterministic or UI-coupled. |
| VII | Explicit Configuration, No Defaults, No Telemetry | ✅ Pass | Uses the user's currently configured provider/model; introduces no default, no env var, no telemetry. |
| VIII | Private, Ordered, Durable State | ✅ Pass | No new durable state; skill is read-only Markdown loaded through existing private-storage-respecting registry. |

**Gate result: PASS — zero violations, zero complexity-tracking entries.**

### Note on two spec FRs (deliberate refinement)

The clarified spec stated two *hard* guarantees that a non-executing Markdown skill **cannot** enforce in code:

- **FR-006** (hard concurrency cap of 5)
- **FR-012** (cross-subagent same-path write serialization)

Per the constitution's Governance rule ("on conflict, the constitution wins for governance and principle decisions"), NON-NEGOTIABLE Principle II takes precedence: `/fleet` must be a skill, so these become **model-guided discipline** written into the skill body, not hard-enforced code. Existing core bounds limit the worst case:

- Each subagent is independently bounded (steps, tool-only loops, summary length, output tokens), so cost is already capped per worker regardless of fan-out.
- The existing within-subagent same-path mutation guard (`src/llm/tools/toolContext.ts` `inFlightMutationPaths`) already prevents a single subagent from clobbering its own concurrent edits. Cross-subagent same-path edits are steered away by skill guidance ("assign each subtask a disjoint set of files; if two tasks must touch the same file, merge them into one subtask or run sequentially").

**Deferred enhancement (only if empirical use proves insufficient):** a minimal, justified core primitive that shares a write-lock set across a turn's subagent contexts to hard-enforce FR-012 cross-subagent. This is intentionally NOT in scope now — it would add shared mutable state across `streamText` runs (Principle VI caution) and is not justified while soft guidance suffices.

## Project Structure

### Documentation (this feature)

```text
specs/001-fleet-subagents/
├── plan.md              # this file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── skill-invocation.md   # the /fleet skill's public contract
└── tasks.md             # Phase 2 output (/speckit.tasks — not created here)
```

### Source Code (repository root)

```text
examples/skills/
└── fleet/
    └── SKILL.md          # the feature: shipped example skill (Markdown only)

tests/skills/
└── exampleFleetSkill.test.ts   # smoke test: validates examples/skills/fleet/SKILL.md frontmatter + loadability
```

**Structure Decision**: Single new file (`examples/skills/fleet/SKILL.md`) plus one validation test. No `src/` changes — the feature is a Markdown skill that reuses the existing `subagent` tool and skill system. This is the constitution-minimal layout (Principle II). If a longer reference is warranted (e.g., parallelization heuristics, examples), add `examples/skills/fleet/references/*.md` linked from the body; keep `SKILL.md` itself concise (it loads first).

## Complexity Tracking

> No violations to justify. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

The only design trade-off (hard-enforce vs. soft-guide FR-006/FR-012) is resolved *in favor* of the simpler alternative (soft skill guidance) to comply with Principle II; the more complex option (core write-lock primitive) is deferred and would require its own justification if revisited.
