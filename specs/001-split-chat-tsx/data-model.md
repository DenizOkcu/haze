# Phase 1 Data Model: Split chat.tsx

This is a pure internal refactor; no new persisted entities or data shapes are introduced. The entities below are the existing in-memory structures whose ownership moves between modules — listed so the split keeps their types and flow identical.

## Entities (existing, unchanged)

- **ChatScreen state**: mode/picker state, input history, context-file signature map, tasks, token display, debug log handle. Ownership stays in `commands/chat.tsx`; only the function bodies that compute with them move.
- **Message / TranscriptStaticItem** (`chat/transcriptPartition.ts`, `chat/messages.tsx`): display state for the append-only `<Static>` prefix and dynamic tail. Types unchanged.
- **PromptSession / conversation ref** (`llm/systemPrompt.ts`, `chat.tsx` refs): durable model conversation; refs stay in `chat.tsx`, turn execution logic moves to `agentTurnRunner.ts`.
- **SessionRecorder / SessionLifecycle / WizardDispatch** (`chat/sessionRecorder.ts`, `chat/sessionLifecycle.ts`, `chat/wizardDispatch.ts`): already-extracted controllers; the split only adjusts how `chat.tsx` calls them.

## Validation rules (unchanged, enforced by existing checks)

- No `any` (ESLint `no-explicit-any`); explicit narrow types at module boundaries.
- ESM `.js` import extensions; no new circular imports between `commands/` and `chat/`.
- `npm run typecheck && npm test && npm run lint` must pass with zero test modifications.

## State transitions

None added. Turn/session state machines remain owned by `commands/streaming/*` and `chat/sessionLifecycle.ts`.
