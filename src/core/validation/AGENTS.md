# src/core/validation/AGENTS.md

Last updated: 2026-07-09 for the 0.8.0 release.

Validation-output parsing.

## Purpose

`outputParser.ts` turns noisy command output into compact `ValidationSummary` objects used by the bash tool and bash-output reducers.

## Contracts

Maintainability focus:

- Validation parsing consumes bash classification metadata but must remain useful even when classification is conservative or unknown.

- Infer validation kind from command text and bash classification traits: typecheck, lint, build, test, or generic.
- Parse common TypeScript, ESLint, Vitest/Jest, and generic `file:line:column` diagnostics.
- Parsed failure evidence is authoritative even if shell pipelines mask a non-zero exit code.
- Summaries should include compact failed files/tests/diagnostics and an actionable `suggestedNextStep` when failed.
- Respect truncation/timed-out inputs in status and metadata.
- Keep returned arrays bounded so validation summaries stay small.

## Tests

Update `tests/core/validationParser.test.ts` for every parser heuristic change, including edge cases with piped output and truncated streams.
