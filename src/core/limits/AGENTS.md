# src/core/limits/AGENTS.md

Last updated: 2026-07-10 for the security/correctness remediation (unreleased).

Centralized byte budgets.

## Responsibilities

- `byteBudgets.ts` exports every collection-time and storage-time byte limit.
- `textBudgets.ts` exports the model-facing character caps (tool output pages, grep rendering, session previews) so those live in one place too (CR-014).

## Contracts

- Keep all output/resource limits here so callers cite a named constant instead of a magic number.
- These bound work performed (process output, file reads, JSONL lines, LSP frames/headers/buffers, stored tool-output handles, skill files, exact-mutation size), not only model-facing returned text.
- Changing a value changes availability/memory behavior; mention user-visible changes in `CHANGELOG.md` and docs.

## Consumers

bash/grep collectors, `toolOutputStore`, LSP frame/header/buffer caps, skill `SKILL.md`/reference limits, the exact-mutation size guard, and the bounded JSONL/text readers.
