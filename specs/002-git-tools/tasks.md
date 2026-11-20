---

description: "Task list for the Dedicated Git Tools feature"
---

# Tasks: Dedicated Git Tools

**Input**: Design documents from `/specs/002-git-tools/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/git-tools.md, quickstart.md

**Tests**: Included — repo convention (`src/llm/tools/AGENTS.md`) requires regression tests under `tests/hazeTools/**` for new tool behavior.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Skeleton the new module and register it in the built-in catalog

- [x] T001 Create `src/llm/tools/gitTools.ts` skeleton exporting an empty `gitTools` ToolSet and register it in `src/llm/hazeTools.ts` (`...gitTools`)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared git execution plumbing every git tool depends on — MUST complete before any user story

- [x] T002 Implement bounded git runner in `src/llm/tools/gitTools.ts`: execute `git` via `core/process` `runBoundedProcess` with byte-bounded output, timeout/abort teardown, and structured metadata (mirror `shellTool.ts` patterns)
- [x] T003 Implement workspace confinement + repo resolution in `src/llm/tools/gitTools.ts`: resolve the workspace repo root, refuse with reasonCode `outside_workspace` anything outside it, return a clear `not_a_repository` structured result (recoverable: false) when cwd is not a git repo; inherit `core/safety` secret-file and git-internals protections (never read `.git/config`, credentials, hooks)
- [x] T004 Implement shared failure envelope helpers in `src/llm/tools/gitTools.ts` using `HazeToolError`/`structuredToolFailure` from `src/llm/tools/failures.ts` (`reasonCode`, `recoverable`, `suggestedNextStep`; terminal refusals `recoverable: false`)

**Checkpoint**: Foundation ready — user story implementation can begin

---

## Phase 3: User Story 1 - Read repository state compactly (Priority: P1) 🎯 MVP

**Goal**: Dedicated read-only git tools return compact, structured, bounded repository state (status, log, diff, branch) instead of raw shell output.

**Independent Test**: In a repo with uncommitted changes and history, asking "what changed?" / "recent commits?" / "diff of <file>" is answered via git tools with bounded results; oversized log/diff is truncated with an indicator (quickstart.md scenarios 1–3).

### Tests for User Story 1

- [x] T005 [P] [US1] Behavior tests for read-only git tools in `tests/hazeTools/gitTools.test.ts`: status shape (branch, staged/unstaged/untracked), log entries (hash/subject/author/relativeTime), diff stats+patch, branch list; assert `truncated` indicator and default bounds (~20 commits per data-model.md `GitLogEntry` list bound, ~200 diff lines per `GitDiffResult.patch` bound)

### Implementation for User Story 1

- [x] T006 [P] [US1] Implement `gitStatus` tool in `src/llm/tools/gitTools.ts` returning `GitStatusResult` per contracts/git-tools.md
- [x] T007 [P] [US1] Implement `gitLog` tool in `src/llm/tools/gitTools.ts` with `limit` (default ~20), `range`, `path` params per contracts/git-tools.md
- [x] T008 [P] [US1] Implement `gitDiff` tool in `src/llm/tools/gitTools.ts` with `path`, `range`, `staged`, `limit` (default ~200 lines) per contracts/git-tools.md
- [x] T009 [P] [US1] Implement `gitBranch` tool in `src/llm/tools/gitTools.ts` with `remotes` option per contracts/git-tools.md

---

## Phase 4: User Story 2 - Model prefers git tools over shell (Priority: P1)

**Goal**: Standing guidance makes the model use the git tools instead of `git` via shell; shell remains the explicit fallback.

**Independent Test**: In a fresh session, asking for branch/recent commits uses a `git*` tool, not a `git` shell call (quickstart.md scenario 4); explicit raw-git requests still run via `shell` (scenario 6).

### Tests for User Story 2

- [x] T010 [US2] Prompt-sync test in `tests/llm/` asserting `buildSystemPrompt` output contains the git-tool steering rule and that the rule names the real registered tool names from `src/llm/hazeTools.ts`

### Implementation for User Story 2

- [x] T011 [US2] Add concise steering rule to `src/llm/systemPrompt.ts` (keep synced with real tools per `src/llm/AGENTS.md`): use the dedicated git tools for git operations instead of `git` via `shell`; shell git only when the user explicitly asks for a raw command or an uncovered case

---

## Phase 5: User Story 3 - Safe, bounded git operations incl. mutating actions (Priority: P2)

**Goal**: Bounds are always enforced with truncation indicators, workspace confinement refuses outside-repo requests, and the clarified full-coverage mutating operations (stage, commit, branch, rebase, reset) work through the tools — destructive/history-rewriting actions only on explicit user request.

**Independent Test**: Oversized log/diff is truncated with an indicator (quickstart.md scenario 3); non-git directory yields `not_a_repository`; outside-workspace path yields `outside_workspace`; a staged commit via tools produces a real commit (quickstart.md scenarios 3, 5).

### Tests for User Story 3

- [x] T012 [P] [US3] Refusal/edge tests in `tests/hazeTools/gitTools.test.ts`: `not_a_repository` in a non-git dir, `outside_workspace` refusal, truncation indicators on oversized log/diff, git-internals/secret protection honored
- [x] T013 [P] [US3] Mutating-op tests in `tests/hazeTools/gitTools.test.ts` against a temp git repo: `gitStage`, `gitCommit`, `gitBranchManage` (create/checkout/delete), `gitRebase`/`gitReset` guarded so destructive modes require explicit parameters; failure envelope has `reasonCode`/`recoverable`/`suggestedNextStep`

### Implementation for User Story 3

- [x] T014 [P] [US3] Implement `gitStage` and `gitCommit` in `src/llm/tools/gitTools.ts` per contracts/git-tools.md
- [x] T015 [P] [US3] Implement `gitBranchManage` (create/delete/rename/checkout) in `src/llm/tools/gitTools.ts` per contracts/git-tools.md
- [x] T016 [US3] Implement `gitRebase` and `gitReset` in `src/llm/tools/gitTools.ts` with explicit required target/mode params; destructive modes only on explicit user request (constitution Principle I: no confirmation gates)

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T017 Update CLI formatters (`src/cli/**/formatters.ts`) if git tool result summaries are displayed, and keep tool result shapes aligned with `src/llm/toolResultTypes.ts` (public contract per `src/AGENTS.md`)
- [x] T018 Run the full gate: `npm run typecheck && npm test && npm run lint` (plus `npm run build` before release) and fix any fallout
- [x] T019 Manual smoke per `specs/002-git-tools/quickstart.md` scenarios 1–6 via `npm run dev`

---

## Dependencies

- US1 (Phase 3) depends on Foundational (Phase 2); MVP = Phases 1–3
- US2 (Phase 4) depends on US1 tool names existing (so the prompt rule can name real tools)
- US3 (Phase 5) depends on Foundational; mutating tools depend on the same runner as US1
- Polish (Phase 6) depends on all story phases

## Parallel Opportunities

- T005 with T006–T009 (tests alongside read-only tools, different concerns in same files — sequence within the phase)
- T006/T007/T008/T009 are independent tools in one file — implement sequentially in `gitTools.ts` or split helpers
- T012 and T013 are independent test files additions
- T014/T015 are independent mutating tools
