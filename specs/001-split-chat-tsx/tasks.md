---

description: "Task list template for feature implementation"
---

# Tasks: Split chat.tsx

**Input**: Design documents from `/specs/001-split-chat-tsx/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, quickstart.md

**Tests**: Not requested — this is a behavior-preserving refactor verified by the existing suite (`npm run typecheck && npm test && npm run lint` must pass with zero test modifications). No new test tasks.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

## Path Conventions

- Single project: `src/`, `tests/` at repository root

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Baseline the current behavior before touching anything

- [X] T001 Record baseline: run `npm run typecheck && npm test && npm run lint` on branch `001-split-chat-tsx` and confirm all green; record `wc -l src/cli/commands/chat.tsx` (905)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: None — no shared infrastructure is introduced; the refactor only moves existing code. US1 tasks may start immediately after T001.

---

## Phase 3: User Story 1 - Maintainer Reads a Focused Chat Component (Priority: P1) 🎯 MVP

**Goal**: Decompose `src/cli/commands/chat.tsx` (905 lines) into smaller single-responsibility modules under `src/cli/chat/`, following the established CR-006 extraction pattern, with `chat.tsx` kept as orchestration glue.

**Independent Test**: After each extraction, `npm run typecheck && npm test && npm run lint` pass with zero test modifications, and `wc -l src/cli/commands/chat.tsx` shrinks accordingly (SC-001, SC-002).

### Implementation for User Story 1

- [X] T002 [US1] Extract `finalizeMessage` (chat.tsx ~lines 137-287) into new `src/cli/chat/messageFinalize.ts` as an exported function with explicit parameters; update `src/cli/commands/chat.tsx` to import and call it (pure code motion, no logic edits)
- [X] T003 [US1] Extract `submit` (chat.tsx ~lines 458-564) into new `src/cli/chat/submitPipeline.ts`; update `src/cli/commands/chat.tsx` call site
- [X] T004 [US1] Extract `runSingleAgentTurn` (chat.tsx ~lines 622-862) into new `src/cli/chat/agentTurnRunner.ts`; keep the `runAgentTurn` callback contract stable; update `src/cli/commands/chat.tsx` call site
- [X] T005 [US1] After all three extractions: verify `npm run typecheck && npm test && npm run lint` all pass, no test files modified, no `any` introduced, `.js` import extensions used, no new circular imports, and `wc -l src/cli/commands/chat.tsx` is well under half of 905 (SC-001)

**Checkpoint**: User Story 1 complete — chat.tsx is orchestration glue, largest remaining module well under half the original size, all checks green.

---

## Phase 4: User Story 2 - End User Experiences Zero Change (Priority: P1)

**Goal**: Prove the refactor is invisible: identical chat behavior, rendering, keyboard shortcuts, and slash commands.

**Independent Test**: Full validation suite plus interactive smoke per `quickstart.md`; zero test modifications (SC-002, SC-003).

### Verification for User Story 2

- [X] T006 [US2] Run full gate `npm run typecheck && npm test && npm run lint` and confirm zero test-file changes vs. baseline (SC-002)
- [X] T007 [US2] Run `npm run build` to confirm `dist/` regenerates cleanly (never edit `dist/` directly)
- [X] T008 [US2] Interactive smoke via `npm run dev`: send a message, observe streaming settle into `<Static>`, run `/help`, resize terminal (Static replay with draft preserved), `/exit` — behavior identical to pre-refactor (SC-003)

**Checkpoint**: User Story 2 complete — zero user-visible change confirmed.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Final conformance sweep

- [X] T009 Confirm transcript invariants intact per AGENTS.md: `<Static>` append-only prefix, width-keyed replay in `src/cli/chat/resizeGuard.ts`, dynamic-tail row budget in `src/cli/chat/liveRegion.ts` — covered by `tests/cli/chat/resizeBoundary.test.tsx` passing unmodified
- [X] T010 Final gate: `npm run typecheck && npm test && npm run lint && npm run build` all green (quickstart.md validation)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Empty — no blocking prerequisites
- **User Stories (Phase 3+)**: Depend only on T001 baseline; US1 before US2 (US2 verifies US1's output)
- **Polish (Phase 5)**: Depends on US1 + US2 completion

### User Story Dependencies

- **User Story 1 (P1)**: No dependencies on other stories; T002 → T003 → T004 → T005 sequential (all touch `src/cli/commands/chat.tsx`)
- **User Story 2 (P1)**: Depends on US1 being complete (it verifies the refactor)

### Within Each User Story

- Extractions are sequential (same file `chat.tsx`); validation after each extraction
- Verification tasks T006–T008 are sequential (build depends on lint-clean source)

### Parallel Opportunities

- None within US1 (single file being edited); the three new modules are created in sequence but could be drafted in parallel by different agents if split into separate branches — not recommended for this low-risk refactor

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete T001 baseline
2. Complete T002–T005 (the split itself)
3. **STOP and VALIDATE**: `npm run typecheck && npm test && npm run lint` green, size goal met

### Incremental Delivery

1. T001 baseline → T002–T005 split (US1, the deliverable)
2. T006–T008 zero-change verification (US2)
3. T009–T010 final conformance gate

---

## Notes

- [P] tasks = different files, no dependencies (none here — single-file edit chain)
- [Story] label maps task to specific user story for traceability
- Pure code motion: move function bodies verbatim, change only parameter lists/call sites
- Never edit `dist/`; commit after each extraction task
