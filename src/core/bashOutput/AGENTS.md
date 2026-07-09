# src/core/bashOutput/AGENTS.md

Last updated: 2026-07-09.

Command-aware reduction of bash stdout/stderr.

## Goals

Maintainability focus:

- Bash risk classification is informational for tool results and reducers; do not rely on output reducers to enforce command permission.

- Preserve actionable failure information while keeping model context compact.
- Prefer structured/semantic reducers over blind truncation.
- Always expose retrieval metadata/handles when raw output is omitted and storage is available.

## Pipeline

`registry.ts` orchestrates reducers in this order:

1. Validation summaries for failing validation output.
2. Git reducers.
3. GitHub CLI reducers.
4. Search reducers.
5. Unified diff, JSON, and generic log reducers.
6. Command-specific line filters.
7. Generic cap/passthrough fallback.

Keep this order intentional: earlier reducers have more semantic knowledge.

## Reducer contracts

- Reducers should return `undefined` when they are not confident, not low-quality rewrites.
- Do not inflate output. `registry.ts` protects against inflation for large filtered content; new reducers should still avoid it.
- Preserve errors, failing test names, file paths, line numbers, exit-code context, and next-action hints.
- Strip ANSI only where appropriate; `ansi.ts` centralizes ANSI handling.
- Include metrics via `reductionMetrics` and set `contentKind`, `lossy`, `parseTier`, `reducerName`/`filterName` accurately.
- If a reducer mixes stdout/stderr, ensure the non-primary stream is handled consistently so display does not duplicate content.

## Line filters

- Built-in line filters are for noisy commands (`markdownlint`, `shellcheck`, Docker/Kubernetes lists, Terraform, Make, system lists).
- Add filters only for commands with stable output patterns.
- `onEmpty` should be truthful; do not claim success if empty output can mean failure.

## Tests

Update targeted tests under:

- `tests/core/bashOutput/*.test.ts`
- `tests/core/bashOutput/reducers/*.test.ts`
- `tests/hazeTools/bash.test.ts` when bash tool result shape/display changes.
