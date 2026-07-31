# Subagent Value Improvements — Agentic Workflow Status

- Feature slug: `subagent-value-improvements`
- Created: 2026-07-31T00:00:00Z
- Last updated: 2026-07-31T10:52:00Z
- Current phase: live fleet behavior hardening complete
- Next action: Interrupt the old long-running turn if it is no longer useful, restart haze, and rerun once with the new bounded-review guidance.

- Review loop: 2/3
- Overall status: complete

## User Request

See [REQUEST.md](REQUEST.md).

## Gates

| Gate | Status | Evidence | Decision |
|---|---|---|---|
| G0 Intake ready | pass | `REQUEST.md`, source proposal artifacts, and acceptance criteria exist. | Proceed to research. |
| G1 Research complete | pass | `RESEARCH.md` reconciles F0–F14 and C1–C8 with AI SDK v7, context loading, persistence, settings, providers, mutation policy, and tests. | Proceed to planning. |
| G2 Plan actionable | pass | `PLAN.md` defines resolved decisions, exact contracts/files/phases, AC-mapped tests, validation, risks, rollback, and a single-agent checklist covering every implement-now disposition. | Proceed to implementation. |
| G3 Implementation complete | pass | `IMPLEMENTATION.md` maps every non-deferred checklist item; full typecheck, 931 tests, lint, build, and package dry-run pass. | Proceed to independent review. |
| G4 Review acceptable | pass | `REVIEW.md` round 2 independently verified every required round-1 fix; verdict pass-with-nits with no critical/high findings or unresolved required changes. | Proceed to production readiness. |
| G5 Review fixes complete | pass | All required round-1 findings are mapped in `IMPLEMENTATION.md`; focused 88 tests, full 943 tests, typecheck, lint, build, package dry-run, and diff check pass. | Proceed to fresh review round 2. |
| G6 Production ready | pass | `PRODUCTION_READINESS.md` confirms aligned docs/help/settings, ignored private `.pi-sessions`, clean package contents, and a fresh passing full release sequence (943 tests). | Proceed to retrospective. |
| G7 Retrospective complete | pass | `RETROSPECTIVE.md` captures successes, round-1 hard-limit failure causes, weak gates, process improvements, codebase-specific runtime lessons, and next-iteration recommendations. | Workflow complete. |

## Phase Log

| Time | Phase | Agent/session | Status | Notes |
|---|---|---|---|---|
| 2026-07-31T00:00:00Z | intake | orchestrator | complete | Request and gates initialized. |
| 2026-07-31T07:11:51Z | research | `019fb703-abed-7ee8-b770-453b006cddb9` | started | Reading proposals, project contracts, implementation, and tests. |
| 2026-07-31T07:20:30Z | research | `019fb703-abed-7ee8-b770-453b006cddb9` | complete | Wrote `RESEARCH.md`; recommended four mergeable phases and deferred only speculative follow-ups. |
| 2026-07-31T07:21:29Z | planning | `019fb70c-7c78-729d-bfc7-23e0471b57ac` | started | Converting all implement-now dispositions into one compatibility-safe implementation plan. |
| 2026-07-31T07:25:36Z | planning | `019fb70c-7c78-729d-bfc7-23e0471b57ac` | complete | Wrote `PLAN.md`; resolved profiles/model selection, V2/V1 migration, context assembly, coordinator/deadline, ephemeral fleet, mutation policy, tests, and explicit deferrals. |
| 2026-07-31T07:26:33Z | implementation | `019fb711-08c1-7c2a-820a-6ea29a3e1620` | started | Read workflow artifacts and relevant subtree contracts; implementing all non-deferred checklist items. |
| 2026-07-31T07:48:34Z | implementation | `019fb711-08c1-7c2a-820a-6ea29a3e1620` | complete | Implemented all non-deferred phases, wrote `IMPLEMENTATION.md`, and passed full release validation (104 files / 931 tests). |
| 2026-07-31T07:50:00Z | review round 1 | orchestrator | started | G3 evidence accepted; launching independent security/correctness review. |
| 2026-07-31T07:51:00Z | review round 1 | fresh review agent | started | Reading workflow artifacts, instructions, actual tracked diff, and all untracked source/test files. |
| 2026-07-31T07:52:51Z | review round 1 | fresh review agent | complete | Verdict changes-required; focused 136 tests passed, but a never-settling-worker repro proved the deadline is not hard. Wrote `REVIEW.md`; G4 failed. |
| 2026-07-31T08:00:00Z | review-fix round 1 | `019fb72b-18b1-715e-92e1-5cbfa313411f` | started | Addressing all required deadline, tool-budget, retry-scope, fairness, validation-truth, event, and deterministic coverage findings. |
| 2026-07-31T08:02:50Z | review-fix round 1 | `019fb72b-18b1-715e-92e1-5cbfa313411f` | complete | Added logical terminal delivery with physical quarantine/settlement, hard per-execution tool caps, first-wins truth, retry-wide scope, FIFO fairness, validation filtering, AI SDK/JSONL regressions, and passed full release validation. |
| 2026-07-31T08:04:00Z | review round 2 | orchestrator | started | G5 accepted; launching fresh independent verification. |
| 2026-07-31T08:05:56Z | review round 2 | `019fb735-02c9-7396-9fe9-a5810e88399f` | started | Reading all artifacts, relevant contracts, complete diff, and untracked source/tests; independently verifying every round-1 finding. |
| 2026-07-31T08:09:17Z | review round 2 | `019fb735-02c9-7396-9fe9-a5810e88399f` | complete | Verdict pass-with-nits; all round-1 required fixes verified. Typecheck, lint, diff check, and 147 focused tests passed; no unresolved required changes. |
| 2026-07-31T08:11:02Z | documentation/production readiness | `019fb739-c4f2-7de3-b487-9b437d4a80f6` | started | Verifying user docs/help/settings, privacy and package boundaries, and final release evidence. |
| 2026-07-31T08:12:30Z | documentation/production readiness | `019fb739-c4f2-7de3-b487-9b437d4a80f6` | complete | Added changelog release notes and `.pi-sessions/` ignore rule; wrote `PRODUCTION_READINESS.md`; full release validation and package privacy inspection passed. |
| 2026-07-31T08:14:26Z | retrospective | `019fb73c-c967-7b13-8135-0bbac78f4ca0` | started | Reading all workflow and proposal artifacts; extracting gate, runtime-boundary, context, and persistence lessons. |
| 2026-07-31T08:15:56Z | retrospective | `019fb73c-c967-7b13-8135-0bbac78f4ca0` | complete | Wrote `RETROSPECTIVE.md`; documented why cooperative tests missed hard limits, strengthened future gates, and closed G7. |
| 2026-07-31T10:30:00Z | field validation | main session | complete | A local model emitted empty `{}` inputs for the transitional union schema. Replaced it with one flat required capsule, clarified fleet control, and added schema regressions. |
| 2026-07-31T10:32:00Z | field validation 2 | main session | complete | Valid capsules reached AI SDK, which rejected an unnecessary undefined subagent tool context. Removed the context schema and changed the installed-SDK integration to mirror the real main turn. |
| 2026-07-31T10:36:00Z | field validation 3 | main session | complete | Workers started after model self-repair, but strict 1,200-character objectives wasted the first wave. Raised the bounded ceiling to 4,000 while prompting for under 1,000; full 943-test validation passes. |
| 2026-07-31T10:52:00Z | live behavior hardening | main session | complete | Broad audits exhausted budgets and triggered repeated retries/scope repair. Added concrete worker budget guidance, mandatory partial synthesis, pre-mapping/focused-scope fleet rules, one-retry limit, and a tolerant bounded 32-path ceiling; 944 tests pass. |

## Files Changed

- Product source under `src/core/subagent/`, `src/core/agent/`, `src/core/session/`, `src/config/`, `src/llm/`, and `src/cli/`.
- Deterministic tests under `tests/core/subagent/`, `tests/llm/`, `tests/config/`, `tests/cli/`, and `tests/core/sessionStore.test.ts`.
- User/contract docs: `README.md`, `CHANGELOG.md`, `docs/index.html`, relevant nested `AGENTS.md`, and this workflow folder.
- Readiness/privacy: `.gitignore` excludes local child `.pi-sessions`; `PRODUCTION_READINESS.md` records package and launch evidence.
- Review artifact: `docs/subagent-value-improvements/REVIEW.md`.
- Proposal artifacts under `specs/002-subagent-value-improvements/` remain untracked and were preserved unchanged.

## Resume Instructions

Workflow implementation remains complete. Re-run the original local-model fleet prompt to validate the flat schema empirically; preserve prior gate evidence, proposal artifacts, ignored `.pi-sessions` runtime state, and unrelated `.fleet-review/` user output.
