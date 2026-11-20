# Quickstart / Validation Guide: Split chat.tsx

This feature is a behavior-preserving refactor; "it works" means the existing checks pass unmodified and the chat screen behaves identically.

## Prerequisites

- Node >=22.13, `npm ci` already run in the repo root.
- Work on branch `001-split-chat-tsx`.

## Validation scenarios

1. **Static verification** (proves the split is behavior-preserving):
   - `npm run typecheck` — must pass.
   - `npm test` — must pass with **zero test-file modifications** (SC-002).
   - `npm run lint` — must pass (no `any`, no unused vars, `.js` import extensions).
2. **Size goal** (SC-001): after the split, `wc -l src/cli/commands/chat.tsx` is well under half of 906 lines, and each new `src/cli/chat/` module is substantially smaller than the original file.
3. **Interactive smoke** (SC-003): `npm run dev`, then in the chat screen — send a message, watch streaming output settle into the transcript, run a slash command (e.g. `/help`), resize the terminal (Static replay, draft preserved), and `/exit`. Behavior must match the pre-refactor build.
4. **Build confidence**: `npm run build` regenerates `dist/` (never edit `dist/` directly).

## Expected outcomes

- All checks green with no assertion changes.
- No user-visible difference in rendering, keyboard handling, streaming, tool groups, task bar, or slash commands.
