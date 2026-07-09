# src/core/goal/AGENTS.md

Last updated: 2026-07-09.

Request intent classification and lightweight goal/completion policy.

## Responsibilities

- `requestClassifier.ts` classifies the user's request intent (`plan`, `test`, `review`, `answer`, implementation-style work). Keep heuristics deterministic and transparent.
- `sessionGoal.ts` creates/updates `WorkState` success criteria from the initial user request and observed tool events.
- `completionPolicy.ts` provides model-facing control prompts for repeated tools, tool-loop budgets, and completion/continuation decisions.

## Contracts

Maintainability focus:

- Keep completion prompts small and reusable; prefer one shared helper over embedding near-identical model-facing control text in multiple loops.

- Classifiers are hints, not hard authorization. Avoid preventing legitimate work solely because of a heuristic.
- Plan-only requests should not lead to source mutations unless the user asks for implementation.
- Goal status text is shown in UI; keep it short and stable.
- Control prompts should be specific enough to redirect the model without becoming durable conversation history.

## Tests

Update `tests/core/goal.test.ts` and streaming tests when intent classification changes autonomy behavior.
