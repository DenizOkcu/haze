# Contract: the `/fleet` skill invocation

**Branch**: `001-fleet-subagents` | **Date**: 2026-07-09

`/fleet` is a **skill**, so its public contract is the standard haze skill contract plus the behavior the skill body promises. There is no new tool, endpoint, or code API.

## 1. Skill file contract (existing, unchanged)

`examples/skills/fleet/SKILL.md` MUST conform to the haze skill format:

- YAML frontmatter delimited by `---`.
- Required fields: `name: fleet` (letters/numbers/hyphens/underscores only) and a non-empty `description`.
- Body is Markdown instructions only; it MUST NOT execute code.
- `SKILL.md` ≤ `SKILL_MARKDOWN_BYTES` (256 KB); any referenced files live inside the skill dir and are real-path-confined.

Validation is performed by the existing `SkillLoader`/`SkillRegistry`; an invalid skill is isolated (first valid wins) and never breaks built-ins.

## 2. Invocation contract (existing, unchanged)

- **Command**: `/fleet <prompt>` — matched by `skillInvocation()` in `src/cli/commands/chat.tsx`.
- **Args**: the text after `/fleet ` becomes the user message (the Fleet Prompt).
- **Discoverability**: the `fleet` skill appears in the `skill` catalog tool and the `/skills` picker; it is invocable as `/fleet` only when enabled (`isSkillEnabled`).
- **Disabled state**: a disabled `fleet` skill is absent from the catalog and not invocable as `/fleet` — identical to every other skill.

## 3. Behavioral contract (what the skill body promises)

When invoked with a non-empty prompt, the skill instructs the model to:

| ID | Behavior | Spec ref |
|----|----------|----------|
| B1 | Analyze the prompt to decide if it decomposes into 2+ genuinely independent tasks, and state that decision. | FR-002, FR-005 |
| B2 | If parallelizable: enumerate subtasks and spawn **one `subagent` tool call per subtask in a single step**, ≤ 5 concurrent. | FR-003, FR-006 |
| B3 | Assign each subtask a **disjoint set of files**; if two tasks must touch the same file, merge them or run sequentially. | FR-012 |
| B4 | If not parallelizable: inform the user with the reason and **stop** (do not auto-run as a normal turn). | FR-004 |
| B5 | After subagents return, aggregate their summaries into one consolidated answer (per-subtask status + summary). | FR-007, FR-009 |
| B6 | Surface the decomposition plan (the subtask list) in the answer. | FR-005 |
| B7 | On empty/whitespace-only prompt: ask the user for a prompt; do not fan out. | Edge case |

Non-behavioral guarantees (abort, per-worker bounds, within-subagent same-path guard, status computation) are provided by existing core and are NOT part of the skill body — they hold for every turn.

## 4. Non-contractual / out of scope

- The skill does not define a JSON schema for "Decomposition." Decomposition is model reasoning surfaced as prose.
- The skill does not control UI rendering; per-subtask progress relies on existing grouped tool-activity display.
- Hard-enforcement of the cap (FR-006) and cross-subagent same-file safety (FR-012) is intentionally NOT promised as a code guarantee (see plan.md Constitution Check note and research.md D4/D5).
