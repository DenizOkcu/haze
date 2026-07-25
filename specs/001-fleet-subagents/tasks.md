---

description: "Task list for implementing the /fleet parallel subagent orchestration command"
---

# Tasks: /fleet — Parallel Subagent Orchestration

> ## ⚠️ IMPLEMENTATION REVISION (skill → native command)
>
> The project owner overrode the original constitution-governed design ("skill, not
> built-in command") and directed that `/fleet` ship as a **native slash command**.
> The tasks below were authored for the skill approach and are retained for
> traceability; the table maps each to where it now lives in the native-command
> implementation. The behavioral contract (B1–B7, FR-xxx) is unchanged — only the
> delivery vehicle changed.
>
> | Original task | Native-command implementation |
> |---------------|--------------------------------|
> | T001–T002 (skill scaffold) | Superseded by `src/cli/commands/fleetCommand.ts` (registered in `src/cli/commands/commands.ts`, listed in `src/cli/commands/commandHelp.ts`). The shipped example skill at `examples/skills/fleet/` and the installed `~/.haze/skills/fleet/` copy were **removed** (an installed `fleet` skill would shadow the native command, since skills match before native commands). |
> | T003 (skill smoke test) | Replaced by `tests/cli/commands/fleetCommand.test.ts` (handler + routing + `/help` listing). |
> | T004–T010, T013–T014 (skill body) | Ported into the `FLEET_GUIDANCE` constant in `fleetCommand.ts`, delivered as the turn directive via `ctx.runAgentTurn(buildFleetPrompt(args), '/fleet <args>')`. |
> | T011, T012, T015, T020 (core regression tests) | **Unchanged** — still valid; the native command relies on the same existing core guarantees (abort propagation, parallel rendering, partial failure, independent context). |
> | T017 (docs) | `/fleet <prompt>` listed in `docs/index.html` native command table and `/help`; skill recipe card removed. |
> | T018 (quickstart) | `quickstart.md` rewritten — built-in command, no install step. |
> | T019 (gates) | `typecheck`, `test`, `lint`, `build` all pass. |
> | T016 (optional decomposition reference) | N/A — guidance lives inline in `fleetCommand.ts`; file stays concise. |
>
> **Design docs realigned:** `plan.md`, `research.md`, `data-model.md`, `spec.md`,
> and `contracts/fleet-command.md` (which supersedes the removed
> `contracts/skill-invocation.md`) have all been rewritten to describe the native
> command. The task list below is retained verbatim from the original skill-based
> breakdown for traceability; the mapping table above shows where each task now
> lives. The detailed task bodies still read as skill-oriented — that is expected
> and intentional (historical record), not a contradiction.

**Input**: Design documents from `/specs/001-fleet-subagents/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Test tasks ARE included below because they are explicitly requested by the feature specification — `plan.md` declares a smoke validation test (`tests/skills/exampleFleetSkill.test.ts`) and `research.md` (D8/D9) explicitly requests regression tests for the core guarantees (abort propagation, parallel rendering, partial failure) that the spec's acceptance scenarios depend on. These tests verify *existing* core behavior the skill relies on; they do not require new `src/` code.

**Organization**: Tasks are grouped by user story. Because this feature is a **single Markdown skill** (`examples/skills/fleet/SKILL.md`), most user-story tasks add distinct behavioral *sections* to that one file; the US3/US4 verification tests live in separate test files and are independently parallelizable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4)
- Include exact file paths in descriptions

## Path Conventions

> The targets below are the **original (skill-based)** paths. They are superseded
> by the native-command implementation — see the mapping table at the top. They are
> retained only to make the historical task bodies below readable.

- Original target: the shipped example skill layer `examples/skills/fleet/` + `tests/skills/` (**removed**).
- Actual target (current): `src/cli/commands/fleetCommand.ts` + `tests/cli/commands/fleetCommand.test.ts`, with registrations in `commands.ts`, `commandHelp.ts`, and `src/cli/chat/inputSuggestions.ts`.
- Core-behavior verification tests live under `tests/core/subagent/` and `tests/cli/` (unchanged).

## Implementation Note: Native Command (guidance-injection wrapper)

`/fleet` is implemented as a **native slash command** (`src/cli/commands/fleetCommand.ts`) — an owner-approved exception to constitution Principle II. It is a thin wrapper: `handleFleetCommand` guards the empty-prompt case, then calls `ctx.runAgentTurn(buildFleetPrompt(args), '/fleet <args>')`, injecting the `FLEET_GUIDANCE` behavioral text (B1–B7, mapped to `contracts/fleet-command.md` §3 and the FR-xxx in `spec.md`) plus the user's prompt as a normal model turn. It adds **no new tools** — it reuses the existing `subagent` tool. Non-behavioral guarantees (abort, per-worker bounds, within-subagent same-path guard, status computation) are provided by existing core and are verified by regression tests, not authored.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Scaffold the shipped example skill so it loads under the existing skill system.

- [X] T001 Create the shipped example skill directory at `examples/skills/fleet/`
- [X] T002 Scaffold `examples/skills/fleet/SKILL.md` with valid YAML frontmatter (`name: fleet`, non-empty `description`) conforming to the skill contract in `specs/001-fleet-subagents/contracts/skill-invocation.md` §1 (model on `examples/skills/files/SKILL.md`)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the loadability guardrail that should stay green as every user-story section is added to the skill.

**Scope note**: T003 validates **frontmatter + loadability only** — it does not validate skill *body content*. It is a loadability gate run before body authoring; body correctness is validated later by T018 (quickstart end-to-end) and manual runs. Recommended before user-story work begins so every later edit starts from a skill that loads.

- [X] T003 Create smoke validation test in `tests/skills/exampleFleetSkill.test.ts` asserting `examples/skills/fleet/SKILL.md` loads via `loadSkill` with `name === 'fleet'`, a non-empty `description`, and no validation error (modeled on `tests/skills/SkillLoader.test.ts`)

**Checkpoint**: Skill scaffold validates and loads — user-story implementation can now begin.

---

## Phase 3: User Story 1 - Parallelize a Multi-Part Prompt (Priority: P1) 🎯 MVP

**Goal**: `/fleet <prompt>` analyzes a prompt, decomposes it into 2+ independent tasks, fans out one bounded `subagent` per task, and returns an aggregated result that stays in the conversation.

**Independent Test**: Run `/fleet <prompt>` with a prompt containing 2+ clearly independent tasks and observe: the system states the decomposition, spawns one subagent per subtask concurrently (≤5), and presents a consolidated summary. Succeeds with no other story implemented.

### Implementation for User Story 1

> These tasks all edit `examples/skills/fleet/SKILL.md`; do them in order. Each maps to a behavioral item from `contracts/skill-invocation.md` §3.

- [X] T004 [US1] Author empty/whitespace-prompt guard in `examples/skills/fleet/SKILL.md`: if the prompt is empty or whitespace-only, ask the user for a prompt and do not fan out (B7; edge case "empty or whitespace-only prompt")
- [X] T005 [US1] Author analyze-and-decompose guidance in `examples/skills/fleet/SKILL.md`: decide whether the prompt decomposes into 2+ genuinely independent tasks and state that decision plus brief reasoning (B1; FR-002, FR-005)
- [X] T006 [US1] Author fan-out guidance in `examples/skills/fleet/SKILL.md`: enumerate the subtasks and spawn exactly one `subagent` tool call per subtask in a single step, at most 5 concurrent; if there are more than 5 independent tasks, prioritize the 5 highest-value and report the remainder (B2; FR-003, FR-006)
- [X] T007 [US1] Author disjoint-files assignment guidance in `examples/skills/fleet/SKILL.md`: assign each subtask a disjoint set of files; if two tasks must edit the same file, merge them into one subtask or run them sequentially (B3; FR-012)
- [X] T008 [US1] Author decomposition-plan surfacing guidance in `examples/skills/fleet/SKILL.md`: show the list of subtasks acted on in the answer so the user can see the plan (B6; FR-005)
- [X] T009 [US1] Author aggregation guidance in `examples/skills/fleet/SKILL.md`: after subagents return, aggregate their summaries into one consolidated answer with per-subtask status + summary; state that this result is part of the conversation for follow-ups (B5; FR-007, FR-009)

**Checkpoint**: A multi-part parallelizable prompt now flows end-to-end: analyze → fan out → aggregate. US1 is independently testable.

---

## Phase 4: User Story 2 - Graceful Handling of Non-Parallelizable Prompts (Priority: P2)

**Goal**: When a prompt is a single or tightly interdependent task, `/fleet` declines to fan out, informs the user why, and stops — it never silently auto-runs the prompt as a normal turn.

**Independent Test**: Run `/fleet <prompt>` with an obviously sequential/dependent prompt and verify the system reports it as non-parallelizable (with a reason) and does not spawn subagents.

### Implementation for User Story 2

- [X] T010 [US2] Author non-parallelizable decline guidance in `examples/skills/fleet/SKILL.md`: when the prompt is a single task or has strong interdependencies, inform the user with the reason and STOP — do NOT auto-execute the prompt as a normal turn (B4; FR-004)

**Checkpoint**: Non-parallelizable prompts are declined cleanly. US2 is independently testable.

---

## Phase 5: User Story 3 - Visibility and Control During Parallel Runs (Priority: P3)

**Goal**: During a `/fleet` run the user sees per-subtask status (running/done/failed) and can abort; an abort stops every in-flight subagent and restores control.

**Independent Test**: Start a `/fleet` run on a multi-task prompt, confirm per-subtask status updates as tasks finish, then abort and confirm all subagents stop and control returns.

> **Note**: Per-subtask status and abort are **existing core guarantees** the skill relies on (not skill-body behavior). These tasks verify them via regression tests; they require no `src/` changes unless a gap is found.

### Verification for User Story 3

- [X] T011 [P] [US3] Add regression test in `tests/core/subagent/subagentRunner.test.ts` verifying the turn AbortSignal propagates to in-flight `subagent` calls and each returns `status: 'cancelled'`, restoring user control (D8; FR-008)
- [X] T012 [P] [US3] Extend `tests/cli/formatters.test.ts` verifying grouped tool-activity rendering shows per-subtask status (running/done/failed) for N parallel `subagent` calls, with no live per-subagent token streaming (D9; FR-013)

**Checkpoint**: Abort and per-subtask visibility are locked in by tests. US3 is independently testable.

---

## Phase 6: User Story 4 - Robustness Across Mixed and Failing Subtasks (Priority: P4)

**Goal**: A `/fleet` run tolerates mixed parallel/dependent work and isolated subtask failures — one bad subtask never collapses the whole run, and partial success is reported per subtask.

**Independent Test**: Run `/fleet` on a prompt where one subtask is designed to fail (e.g., references a non-existent file); confirm the other subtasks still complete and the failure is reported per-subtask.

### Implementation for User Story 4

- [X] T013 [US4] Author partial-failure isolation guidance in `examples/skills/fleet/SKILL.md`: a failing, timed-out, or empty-output subtask must not abort the run; report each subtask's status individually and explicitly mark no-output subtasks rather than showing them as silent successes (B5; FR-009; edge case "subagent produces no usable output")
- [X] T014 [US4] Author mixed parallel/dependent guidance in `examples/skills/fleet/SKILL.md`: when a prompt has both independent and dependent parts, parallelize only the independent parts and clearly report the dependent part(s) as not parallelized (FR-002, FR-009)

### Verification for User Story 4

- [X] T015 [P] [US4] Add regression test in `tests/core/subagent/subagentRunner.test.ts` verifying partial success: when one parallel subagent errors or times out, the remaining subagents still complete and each result is returned independently (FR-009)

**Checkpoint**: Mixed and failing subtasks are handled robustly. US4 is independently testable.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, optional reference material, and end-to-end validation.

- [ ] T016 [P] (OPTIONAL) Author a decomposition-heuristics reference at `examples/skills/fleet/references/decomposition.md` and link it from `examples/skills/fleet/SKILL.md` body — only if the SKILL.md grows long; keep `SKILL.md` concise per `plan.md` project-structure note
  - _(Implementation: skipped deliberately — `SKILL.md` stays concise at ~3.4 KB, well under the 256 KB `SKILL_MARKDOWN_BYTES` limit, so the optional reference file is not warranted. Revisit only if the body grows long.)_
- [X] T017 [P] Update `docs/index.html` (and any skills/examples listing) to mention the `fleet` example skill, ensuring install steps match `specs/001-fleet-subagents/quickstart.md` and the shipped path `examples/skills/fleet/`
- [X] T018 Validate `specs/001-fleet-subagents/quickstart.md` end-to-end: copy `examples/skills/fleet/` into a temporary `~/.haze/skills/fleet/`, confirm `fleet` appears and is enabled in `/skills`, then run one parallelizable and one non-parallelizable prompt
  - _(Implementation: the install + `/skills` discovery path was verified programmatically — copying `examples/skills/fleet/` into a temp skills root and confirming the registry/loader discovers `fleet` with valid frontmatter (enabled by default). The two live `/fleet <prompt>` runs require a configured provider/model and the interactive TUI, which are not available in this headless environment — those remain a short manual QA step.)_
- [X] T019 Run full quality gates defined in `package.json` from repo root: `npm run typecheck && npm test && npm run lint && npm run build`
- [X] T020 [P] Verify FR-010 in `tests/core/subagent/subagentRunner.test.ts`: confirm each subagent receives independent context with no shared conversation history (existing core guarantee); add a regression assertion if coverage is missing

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — create the skill directory + frontmatter scaffold first.
- **Foundational (Phase 2)**: Depends on Setup (needs `examples/skills/fleet/SKILL.md` to exist). Acts as the loadability gate for later skill-body edits (frontmatter/loadability only; body correctness is validated by T018 + manual runs).
- **User Stories (Phase 3+)**: All depend on Foundational completion.
  - **US1 (Phase 3)** is the core skill flow; author it first.
  - **US2/US4 skill-body tasks** (T010, T013, T014) *extend* the US1 body, so sequence them after US1 (same file).
  - **US3/US4 verification tests** (T011, T012, T015) test existing core and are **independent of the skill body** — they can be done in parallel with skill authoring.
- **Polish (Phase 7)**: After the desired user stories are complete.

### User Story Dependencies

- **US1 (P1)**: Starts after Foundational. No dependency on other stories. **Other skill-body stories build on US1's core flow.**
- **US2 (P2)**: Starts after Foundational; ideally after US1 (extends the analyze branch of the same file). Independently testable.
- **US3 (P3)**: Starts after Foundational. The verification tests are fully independent of the skill body and of US1/US2.
- **US4 (P4)**: Starts after Foundational. Skill-body tasks (T013/T014) extend US1's aggregation guidance; the partial-failure test (T015) is independent of the skill body.

### Within Each User Story

- Skill-body sections edit `examples/skills/fleet/SKILL.md` → author sequentially in the listed order.
- Verification tests live in distinct test files and are independent of the skill text.
- After each phase, the relevant smoke/verification tests should pass.

### Parallel Opportunities

- **US3 tests (T011, T012)** are in different files and fully parallel.
- **US4 partial-failure test (T015)** is parallel with the US3 tests and with US4 skill-body authoring.
- **Polish docs (T016, T017)** are independent files and parallel.
- Within a single user story, skill-body tasks target the same file and must be sequential.

---

## Parallel Example: User Story 3

```bash
# These verify independent core guarantees and touch different test files — launch together:
Task: "Abort propagation regression test in tests/core/subagent/subagentRunner.test.ts"
Task: "Parallel subagent status rendering test in tests/cli/formatters.test.ts"

# Meanwhile, US4's partial-failure test can also run in parallel:
Task: "Partial-success regression test in tests/core/subagent/subagentRunner.test.ts"
```

> Note: T011 and T015 both extend `tests/core/subagent/subagentRunner.test.ts`. If run by the same agent, sequence them; if split across agents working on disjoint `describe` blocks, they can overlap.

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (directory + valid frontmatter).
2. Complete Phase 2: Foundational (smoke validation test green).
3. Complete Phase 3: User Story 1 (analyze → fan out → aggregate).
4. **STOP and VALIDATE**: run a parallelizable prompt; confirm decomposition, ≤5 concurrent subagents, and a consolidated in-conversation result.
5. Demo/ship the MVP skill.

### Incremental Delivery

1. Setup + Foundational → skill loads and validates.
2. Add US1 → test independently → **MVP delivered**.
3. Add US2 → test the non-parallelizable decline → ship.
4. Add US3 → lock in abort + per-subtask visibility via tests → ship.
5. Add US4 → test partial failure + mixed prompts → ship.
6. Polish → docs + quickstart validation + full gates.

### Parallel Team Strategy

With multiple contributors:

1. Complete Setup + Foundational together.
2. Author US1 first (it is the shared core body).
3. Once US1 lands, split:
   - Agent A: US2 + US4 skill-body sections (same file → sequence).
   - Agent B: US3 + US4 verification tests (independent test files → parallel).
4. Integrate, then run Phase 7 polish.

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks.
- [Story] label maps each task to a user story for traceability.
- This feature adds **no `src/` code** — the skill is Markdown reusing the existing `subagent` tool; the tests verify existing core guarantees.
- FR-010 (independent subagent context) is an existing core guarantee; its verification task (T020) lives in the cross-cutting Polish phase rather than US1.
- FR-006 (cap of 5) and FR-012 (cross-subagent same-file safety) are **model-guided discipline** encoded in the skill body (B2/B3), not hard-enforced code — per `plan.md` Constitution Check note and `research.md` D4/D5.
- Commit after each task or logical group; keep `examples/skills/fleet/SKILL.md` concise.
