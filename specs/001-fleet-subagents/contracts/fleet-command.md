# Contract: the `/fleet` native command

**Branch**: `001-fleet-subagents` | **Date**: 2026-07-09 (revised for native command)

`/fleet` is a **native slash command**. Its public contract is the standard haze command contract plus the behavior the injected guidance promises. There is no new tool, endpoint, or persisted state. (This supersedes the earlier `skill-invocation.md`, which described the now-removed skill approach.)

## 1. Command registration (existing surface, extended)

`/fleet` is registered exactly like the other built-ins:

- **Match**: `exactOrArgs('/fleet')` in `src/cli/commands/commands.ts` → returns `{args: ''}` for bare `/fleet` and `{args: '<rest>'}` for `/fleet <rest>`.
- **Handler**: `handleFleetCommand(args, ctx)` in `src/cli/commands/fleetCommand.ts`.
- **Help listing**: an entry in `COMMAND_HELP_ENTRIES` (`src/cli/commands/commandHelp.ts`), so `/help` shows `/fleet <prompt>`.
- **Autocomplete**: an entry in the static command list in `src/cli/chat/inputSuggestions.ts`, so `/fleet` appears when typing `/`.

## 2. Invocation contract

- **Command**: `/fleet <prompt>`.
- **Args**: the text after `/fleet ` is the Fleet Prompt.
- **Empty/whitespace args**: `handleFleetCommand` emits a usage message (`/fleet needs a prompt... Usage: /fleet <prompt>`) and returns `'handled'` **without** starting a model turn.
- **Non-empty args**: the handler calls `ctx.runAgentTurn(buildFleetPrompt(args), '/fleet <args>')`. `runAgentTurn` is wired to `doAgentTurn` in `chat.tsx`, so the turn runs with the fleet guidance + the prompt as its user message, and is displayed in the transcript as `/fleet <args>` (not the guidance text).
- **Precedence note**: in `chat.tsx`, `skillInvocation()` is evaluated *before* `handleSlashCommand()`. Therefore a skill named `fleet` installed in `~/.haze/skills/fleet/` would shadow the native command. There must be **no** installed `fleet` skill; the example skill was removed for this reason.

## 3. Behavioral contract (what the guidance promises)

`buildFleetPrompt` injects `FLEET_GUIDANCE`, which instructs the model to:

| ID | Behavior | Spec ref |
|----|----------|----------|
| B1 | Analyze the prompt to decide if it decomposes into 2+ genuinely independent tasks, and state that decision. | FR-002, FR-005 |
| B2 | If parallelizable: enumerate the natural number of independent subtasks (2..N) and spawn one `subagent` tool call per subtask, **at most 5 IN FLIGHT at a time**; if there are more than 5, run the rest in successive waves (next batch when the current one returns) until all are done — never drop tasks. | FR-003, FR-006 |
| B3 | **Reads may overlap** across subagents; only **writes** must be disjoint — give each subtask a disjoint set of files to *mutate*; if two tasks must edit the same file, merge them or run sequentially. | FR-012 |
| B4 | If not parallelizable: inform the user with the reason and **stop** (do not auto-run as a normal turn). | FR-004 |
| B5 | After subagents return, aggregate their summaries into one consolidated answer (per-subtask status + summary). | FR-007, FR-009 |
| B6 | Surface the decomposition plan (the subtask list) in the answer. | FR-005 |
| B7 | On empty/whitespace-only prompt: ask the user for a prompt; do not fan out. (Also hard-guarded in the handler.) | Edge case |
| B8 | Decompose along the prompt's natural independent axes (distinct deliverables/features/bugs), not geographic file-slices. The value is **context isolation**: each subagent works in its own context and returns only a concise summary, keeping the main conversation lean — worthwhile even for two tasks. | FR-007 |

Subagents are not context-starved: they inherit the main turn's loaded context files (global + ancestor `AGENTS.md`/`CLAUDE.md`) in their system prompt, and the file tools' lazy `discoverScopedContext` surfaces subtree-specific instructions for the paths each subagent touches (pausing same-subtree writes to review them).

Non-behavioral guarantees (abort, per-worker bounds, within-subagent same-path guard, status computation) are provided by existing core and are NOT part of the guidance — they hold for every turn.

## 4. Non-contractual / out of scope

- The command does not define a JSON schema for "Decomposition." Decomposition is model reasoning surfaced as prose.
- The command does not control UI rendering; per-subtask progress relies on existing grouped tool-activity display.
- Hard-enforcement of the cap (FR-006) and cross-subagent same-file safety (FR-012) is intentionally NOT promised as a code guarantee (see `plan.md` Constitution Check note and `research.md` D4/D5).
