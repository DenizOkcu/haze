# Phase 0 Research: Split chat.tsx

All Technical Context unknowns are resolved from the repository itself (package.json, AGENTS.md, existing `src/cli/chat/` extractions). No NEEDS CLARIFICATION remains.

## Decision: extraction targets and boundaries

- **Decision**: Split `src/cli/commands/chat.tsx` (906 lines) into three new modules under `src/cli/chat/`: `messageFinalize.ts`, `submitPipeline.ts`, `agentTurnRunner.ts`, leaving `chat.tsx` as the `ChatScreen` orchestration glue.
- **Rationale**: `src/cli/AGENTS.md` already mandates this pattern — "Treat `commands/chat.tsx` as orchestration glue" and prior CR-006 work extracted `sessionLifecycle.ts`, `wizardDispatch.ts`, `messages.tsx`, etc. The three largest remaining inline bodies (`finalizeMessage` ~150 lines, `submit` ~106 lines, `runSingleAgentTurn` ~240 lines) account for ~55% of the file; extracting them drops `chat.tsx` well under half its size (SC-001).
- **Alternatives considered**:
  - Extract every small inline function — rejected (YAGNI; churn without context-load benefit).
  - Move `ChatScreen` itself out of `commands/` — rejected (`src/cli/AGENTS.md` explicitly assigns the interactive screen to `commands/chat.tsx`).

## Decision: behavior preservation strategy

- **Decision**: Pure code motion — move function bodies verbatim (or with only parameter-list changes to pass needed state/callbacks explicitly), no logic edits. Verify with `npm run typecheck && npm test && npm run lint` passing with zero test modifications (SC-002).
- **Rationale**: A behavior-preserving split is verifiable by the existing suite (`tests/cli/chat/resizeBoundary.test.tsx`, `tests/cli/messages.test.tsx`, `tests/cli/commands.test.ts`); any logic change would show up as a test failure or review diff.
- **Alternatives considered**: Opportunistic cleanup inside moved bodies — rejected (violates "no UX change / smallest correct change" and muddies review).

## Decision: invariants that must not move/change

- **Decision**: Keep in `chat.tsx`: `<Static>` width-keyed replay, dynamic-tail row budget wiring (`liveRegion.ts`), refs for turn/session machinery, and the `runAgentTurn` callback contract. These are load-bearing transcript invariants named in AGENTS.md.
- **Rationale**: AGENTS.md and `src/cli/AGENTS.md` pin these behaviors; tests (`resizeBoundary.test.tsx`) cover them.
- **Alternatives considered**: Moving transcript invariants into helpers — rejected; they already live in `chat/transcriptPartition.ts` / `chat/liveMessages.ts`.
