# src/core/shellOutput/AGENTS.md

Last updated: 2026-09-22 for the 1.3.0 release (round-1 review fixes).

Command-aware reduction of shell stdout/stderr.

## Goals

Maintainability focus:

- Shell risk classification is informational for tool results and reducers; do not rely on output reducers to enforce command permission.

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

Semantic reducers (steps 2–5) apply only to unambiguous single foreground commands (`isSingleForegroundCommand` from `core/safety/shellClassifier.ts`), so mixed-command or background output falls through to line filters and the generic cap instead of being misread (TS-06). Within that gate, the git reducer additionally requires a leading `git` command word, stdout-owned output (any stderr disqualifies it), and returns `undefined` for status content it cannot parse — never a fabricated clean-status summary.

## Reducer contracts

- Reducers should return `undefined` when they are not confident, not low-quality rewrites.
- Do not inflate output. `registry.ts` protects against inflation for large filtered content; new reducers should still avoid it.
- Preserve errors, failing test names, file paths, line numbers, exit-code context, and next-action hints.
- Strip ANSI only where appropriate; the shared `stripAnsi` in `lineFilter.ts` centralizes ANSI handling.
- Include metrics via `reductionMetrics` and set `contentKind`, `lossy`, `parseTier`, `reducerName`/`filterName` accurately.
- If a reducer mixes stdout/stderr, ensure the non-primary stream is handled consistently so display does not duplicate content.

## Line filters

- Built-in line filters are for noisy commands (`markdownlint`, `shellcheck`, Docker/Kubernetes lists, Terraform, Make, system lists).
- Add filters only for commands with stable output patterns.
- `onEmpty` should be truthful; do not claim success if empty output can mean failure.

## Tests

Update targeted tests under:

- `tests/core/shellOutput/*.test.ts`
- `tests/core/shellOutput/reducers/*.test.ts`
- `tests/hazeTools/shell.test.ts` when shell tool result shape/display changes.
