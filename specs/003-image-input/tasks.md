# Tasks: Image input (F03)

**Input**: `specs/003-image-input/{spec.md,plan.md}`
**Prerequisites**: plan.md (required), spec.md (required)

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 Add `IMAGE_ATTACHMENT_BYTES` and `IMAGE_ATTACHMENTS_PER_MESSAGE`
  named constants to `src/core/limits/byteBudgets.ts`
- [x] T002 Move `formatBytes` from `src/cli/commands/logsCommand.ts` to
  `src/cli/commands/formatters.ts` (shared display formatter, DRY) and update
  the import in logsCommand

## Phase 2: Foundational (Blocking Prerequisites)

- [x] T003 Create `src/core/attachments/imageAttachments.ts`: mention
  extraction, workspace/real-path confined resolution, extension allowlist,
  bounded reads, dedupe, count limit, `userTurnMessage()`,
  `imageCapabilityError()`, image-part byte helpers [P: with T004]
- [x] T004 Make `estimateValueTokens` image-aware in
  `src/core/agent/contextBudget.ts` (bytes heuristic, no byte serialization)
- [x] T005 [US1] Add `capabilities.images` to provider settings schema/type
  (`src/config/settings.ts`) and preserve it in `normalizeProvider`; add
  `providerImageCapable()` (`src/config/providers.ts`)
- [x] T006 Module contract: `src/core/attachments/AGENTS.md`

## Phase 3: User Story 1 - Attach an image (P1) 🎯 MVP

### Tests for User Story 1

- [x] T007 [P] `tests/core/attachments/imageAttachments.test.ts`: mention
  parsing (paths vs emails), resolution (attach, strip, dedupe, nonexistent
  stays literal), oversize rejection (AC3), count limit, non-image error
  (AC5), symlink/workspace escape rejection, `userTurnMessage` shapes (AC1)
- [x] T008 [P] `tests/core/contextBudget.test.ts` additions: image file part
  estimates use the bytes heuristic, not serialized bytes

### Implementation for User Story 1

- [x] T009 Thread attachments through `src/cli/commands/streaming.ts`
  (`TurnExecutionOptions.attachments`; first-attempt user message via
  `userTurnMessage`, plain string unchanged when no attachments)
- [x] T010 Resolve mentions + build display value (`🖼 name (size)` lines) in
  `src/cli/commands/chat.tsx`; image-only prompt fallback text

## Phase 4: User Story 2 - Capability gating (P1)

### Tests for User Story 2

- [x] T011 [P] `tests/config/settings.test.ts` + `tests/config/providers.test.ts`:
  capability persistence, passthrough, `providerImageCapable` default false
- [x] T012 [P] `tests/cli/providerWizard.test.ts`: mark/clear image-capable
  action results; `imageCapabilityError` message (AC2)

### Implementation for User Story 2

- [x] T013 `/provider` toggle: `wizardActions.ts` labels,
  `providerWizard.ts` patch builder + action result, `wizardDispatch.ts`
  handling, `wizardSuggestions.ts` entry
- [x] T014 Gate turns on capability in `chat.tsx` before any model call (AC2);
  show capability in `/settings` summary (`settingsSummary.ts`)

## Phase 5: User Story 3 - Session slimming & resume (P2)

### Tests for User Story 3

- [x] T015 [P] `tests/core/sessionStore.test.ts` additions: image file part
  slimmed to placeholder (media type + byte count), snapshot line stays
  bounded, resume restores placeholder text (AC4)

### Implementation for User Story 3

- [x] T016 Image-part case in `src/core/session/sessionSlimming.ts` → text
  placeholder with filename/media type/byte count

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T017 Docs move together: README image-input section, `commandHelp.ts`
  `/provider` description, `CHANGELOG.md`, `docs/index.html`, nested
  AGENTS.md contracts (`src/core/session`, `src/core/limits`, `src/config`)
- [x] T018 Validation gates: `npm run typecheck && npm test && npm run lint
  && npm run build`, plus `npm pack --dry-run`

## Dependencies & Execution Order

- Phase 1 before everything (constants/shared formatter).
- Phase 2 modules block all stories.
- US1 (T007–T010) is MVP; US2 (T011–T014) gates it; US3 (T015–T016) is
  independent of the chat wiring.
- Tests are written alongside/against the phase 2 modules, then the wiring
  lands.

## Notes

- Headless `-p` stays text-only (FR-10); mention parsing lives in the
  interactive chat path only.
- Commit after each phase that leaves the tree green.
