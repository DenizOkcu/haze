# Haze simplification code review — 2026-06-26

Reviewer stance: senior software architect optimizing for **DRY, KISS, and YAGNI** while preserving current behavior.

## Scope

Reviewed the TypeScript source under `src/`, selected tests under `tests/`, and project conventions in `AGENTS.md`. No production behavior was changed in this review; this is a findings artifact for follow-up implementation.

## Repository health snapshot

- Source size: **91 TS/TSX files, ~10.3k LOC**.
- Largest files:
  - `src/cli/commands/chat.tsx` — **1,526 LOC**
  - `src/llm/hazeTools.ts` — **416 LOC**
  - `src/ui/components/TextInput.tsx` — **390 LOC**
  - `src/cli/commands/streaming.ts` — **388 LOC**
  - `src/cli/commands/commands.ts` — **322 LOC**
- Test suite is broad and useful, but the largest orchestration component (`ChatScreen` in `chat.tsx`) is hard to test directly because most behavior is nested inside the React component.

## Executive summary

The codebase is generally well factored at the domain-module level (`config`, `core`, `llm`, `skills`, `ui`), but several newer product surfaces have accumulated inside a few orchestration files. The main simplification opportunity is not changing algorithms; it is moving implicit state machines and repeated resource-management patterns into small, pure, testable helpers.

Recommended first target: **extract the chat wizard flows from `chat.tsx` into reducer-style modules with tests before moving behavior**. This yields the biggest risk reduction and unlocks further cleanup.

## Priority findings

| Priority | Finding | Main files | Principle |
|---|---|---|---|
| P0 | `ChatScreen` is a multi-responsibility controller and UI component | `src/cli/commands/chat.tsx` | KISS |
| P0 | Provider/LSP/MCP/Skill wizards duplicate the same state-machine shape | `chat.tsx`, `chatModes.ts`, `wizardActions.ts` | DRY |
| P1 | Slash command handling is a long imperative chain | `src/cli/commands/commands.ts` | KISS |
| P1 | File tools repeat workspace/ignored/scoped-context/error boilerplate | `src/llm/hazeTools.ts`, `src/llm/tools/*` | DRY |
| P1 | Settings collection normalization/upsert behavior is inconsistent | `src/config/providers.ts`, `lspSettings.ts`, `mcpSettings.ts` | DRY/KISS |
| P2 | Session/event persistence is scattered through UI callbacks | `chat.tsx`, `sessionStore.ts`, `streaming.ts` | KISS |
| P2 | `TextInput` combines editor buffer, history, suggestions, paste compaction, and rendering | `src/ui/components/TextInput.tsx` | KISS |
| P2 | Some behavior appears duplicated or accidental and should be characterized with tests first | `/clear`, task clearing, model selection edge cases | Tests first |

See `docs/code-review/findings.md` for detailed findings and `docs/code-review/refactor-plan.md` for a behavior-preserving plan.
