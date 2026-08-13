# v0.10.1 Release Hardening — Agentic Workflow Status

- Feature slug: `v0-10-1-release-hardening`
- Last updated: 2026-08-13
- Current phase: implementation complete (awaiting independent review)
- Overall status: in-progress

## User Request

See [REQUEST.md](REQUEST.md). Latest directives:
1. Implement the PLAN.md fixes with a focus on performance and long-running autonomous tool tasks.
2. Implement all missing steps from the plan.

## Scope delivered

All PLAN.md items are now implemented (RH-001 through RH-011), built on a clean HEAD after stashing a non-compiling intermediate hand-off.

| ID | Item | Status |
|---|---|---|
| RH-001 | Batched Git ignore + cursor-aware bounded walk | done |
| RH-002 | Deterministic canonical test command (`maxWorkers: 4`) | done |
| RH-003 | Atomic main execution budgets at the execute boundary | done |
| RH-004 | Layered absolute/per-tool deadlines + `--timeout` | done |
| RH-005 | Model-aware, full-request context budgeting | done |
| RH-006 | Linear, backpressure-aware `stream-json` deltas | done |
| RH-007 | Cache settled transcript Markdown root chunks | done |
| RH-008 | Coalesce full-history session snapshots | done |
| RH-009 | Turn-scoped LSP client pool | done |
| RH-010 | Bounded read-only queue bypass behind a blocked mutation | done |
| RH-011 | `release:verify` metadata consistency script | done |

## Gates

| Gate | Status | Evidence |
|---|---|---|
| Typecheck | pass | `tsc --noEmit` exit 0 |
| Lint | pass | `npm run lint` clean |
| Build | pass | `npm run build` exit 0 |
| Full suite (deterministic) | pass | Three consecutive `npx vitest run` runs: 1364/1364 each |
| AGENTS stamps | pass | `All AGENTS.md stamps are fresh.` |
| Release metadata | pass | `Release metadata consistent at version 0.10.1 (0.10.x).` |
| Audit | pass | `found 0 vulnerabilities` |

## Resume instructions

Read [IMPLEMENTATION.md](IMPLEMENTATION.md) for per-finding detail. All PLAN.md items are implemented and validated; the remaining gate is an independent review pass over the complete diff. The stashed non-compiling intermediate hand-off is preserved (`git stash list`) and superseded — do not reconcile it.
