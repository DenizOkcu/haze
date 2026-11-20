# Implementation Plan: Split chat.tsx

**Branch**: `001-split-chat-tsx` | **Date**: 2026-11-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-split-chat-tsx/spec.md`

## Summary

Decompose `src/cli/commands/chat.tsx` (906 lines) into smaller single-responsibility modules under the existing `src/cli/chat/` helper directory, following the established CR-006 extraction pattern. `chat.tsx` remains the orchestration glue (the `ChatScreen` component and its prop wiring); the large inline function bodies — `finalizeMessage` (~150 lines), `submit` (~106 lines), and `runSingleAgentTurn` (~240 lines) — move into focused, mostly pure helpers. Zero behavior change: no UX, transcript, command, or session-contract change.

## Technical Context

**Language/Version**: TypeScript (ESM, NodeNext, `.js` import extensions), Node >=22.13, ES2022 target.

**Primary Dependencies**: React + Ink (UI layer only, confined to `src/cli/` and `src/ui/`), Vercel AI SDK. No new dependencies.

**Storage**: N/A — no durable state changes; sessions/settings already persist via `config/`/`core/`.

**Testing**: Vitest (`npm test`); relevant suites: `tests/cli/**` (esp. `tests/cli/chat/resizeBoundary.test.tsx`, `tests/cli/messages.test.tsx`, `tests/cli/commands.test.ts`). Verification gate: `npm run typecheck && npm test && npm run lint` (plus `npm run build` before PR confidence).

**Target Platform**: Terminal CLI (POSIX + Windows), Ink TUI.

**Project Type**: CLI.

**Performance Goals**: No runtime performance change; goal is reduced per-file context load (largest chat module well under half of 906 lines).

**Constraints**: Behavior-preserving only; no `any`; no new import cycles; `<Static>` append-only transcript, dynamic-tail row budget, and width-keyed replay invariants must remain intact; `runAgentTurn` callback contracts stay stable; `dist/` never edited directly.

**Scale/Scope**: One file (`src/cli/commands/chat.tsx`) plus new/extended helpers in `src/cli/chat/`; no other subtrees touched.

## Constitution Check

- **I. Expert-Oriented, Light Guardrails**: N/A — internal refactor, no execution-gate change.
- **II. Minimal Core**: PASS — no new native capability; pure maintainability split, exactly the DRY/KISS/YAGNI refactor `src/AGENTS.md` prescribes (>900-line orchestration file = automatic split discussion).
- **III. Bounded Resources**: PASS — no new resources, collectors, or lifecycles introduced.
- **IV. Real-Path/Network Safety**: N/A — no filesystem/network surface changes.
- **V. Truthful Status**: PASS — status computation stays in `commands/streaming/attemptOutcome.ts`; untouched.
- **VI. UI-Agnostic Core**: PASS — all changes stay in `src/cli/` (React/Ink layer); `core/` untouched.
- **VII. Explicit Config**: N/A.
- **VIII. Private Durable State**: PASS — session/settings writes stay in their owning modules; refactor only moves call sites' glue.
- **IX. Delegation**: N/A.

**Gate result**: PASS. Re-check after Phase 1: still PASS (no new violations introduced by the module split).

## Project Structure

### Documentation (this feature)

```text
specs/001-split-chat-tsx/
├── spec.md              # /speckit-specify output
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output (validation guide)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/cli/
├── commands/
│   └── chat.tsx            # slimmed orchestration glue (ChatScreen + wiring)
└── chat/
    ├── messageFinalize.ts      # NEW: finalizeMessage() extracted (was lines ~137-287)
    ├── submitPipeline.ts       # NEW: submit() extracted (was lines ~458-564)
    ├── agentTurnRunner.ts      # NEW: runSingleAgentTurn() extracted (was lines ~622-862)
    └── ...existing helpers unchanged (sessionLifecycle, wizardDispatch, messages, ...)

tests/cli/                  # existing suites must pass unmodified
```

**Structure Decision**: Single-project CLI layout already in place; the split adds three focused modules to the existing `src/cli/chat/` directory rather than creating a new subtree. Extraction order follows dependency depth: `messageFinalize` (leaf display logic) → `submitPipeline` (command routing) → `agentTurnRunner` (turn orchestration, largest).

## Complexity Tracking

N/A — no constitution violations; no table needed.
