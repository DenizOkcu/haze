# REQUEST.md — Haze User Reliability

## Intent

Make Haze more dependable for real repository and terminal work. Every change
must have a user-centered justification that can be explained and tested without
referring to a benchmark, score, rank, or harness.

## Source plan

The objective referenced:
`benchmarks/harbor/reports/2026-08-07-haze-sustainable-improvement-plan.md`

**That file does not exist on disk.** Verified on 2026-08-07:

- `benchmarks/harbor/reports/` does not exist.
- The only Markdown under `benchmarks/` is
  `benchmarks/harbor/results/20260806-terminal-bench-stage1-terminal-bench.md`,
  a benchmark summary table, read only for general context.

Per the hard constraints, benchmark results are context only and must not drive
product requirements. The objective text itself contains a complete, explicit
increment roadmap (Increments 1–6), required tests, review requirements, and
acceptance criteria. That roadmap is therefore treated as the authoritative
product spec for this work, and is recorded here so progress is auditable
without the missing report file.

## Hard constraints (summary, full list in the task brief)

- No benchmark-specific prompts, task detection, verifier assumptions, fixtures,
  or behavior selected by benchmark context.
- No Terminal-Bench runs, no provider credentials, no Harbor/benchmark edits.
- No model-name branching; provider/model agnostic.
- No increases to global step/tool/tool-only/token/subagent/runtime budgets.
- No provider/model env-var configuration.
- No silent system-package installs or toolchain modification.
- No remote telemetry. Metrics from local tests / explicit dogfood only.
- Never infer correctness from assistant prose.
- `status: complete` stays "execution completion". Add evidence, don't redefine.
- Preserve existing JSON/stream-JSON consumers via additive changes.
- Safe events stay bounded: never expose raw commands, tool I/O, credentials, or
  arbitrary third-party errors.
- No edits to `dist/`, generated output, secrets, ignored runtime state, or
  unrelated user changes. No commit/publish/reset/clean/delete unless asked.
- Strict TypeScript, no `any`, `.js` local imports, follow all `AGENTS.md`.

## Workflow artifacts

All live under `docs/haze-user-reliability/`:
`STATUS.md`, `REQUEST.md`, `RESEARCH.md`, `PLAN.md`, `IMPLEMENTATION.md`,
`REVIEW.md`, `PRODUCTION_READINESS.md`, `RETROSPECTIVE.md`.
