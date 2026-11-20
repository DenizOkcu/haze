# Implementation Plan: Dedicated Git Tools

**Branch**: `002-git-tools` | **Date**: 2026-11-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-git-tools/spec.md`

## Summary

Add a dedicated set of git tools to haze's built-in tool catalog so the model can query and act on the current workspace repository through compact, structured, bounded results instead of raw `git` shell output. Standing system-prompt guidance steers the model to these tools over `shell` for git work; the shell remains the explicit fallback. Coverage is the full git surface per the clarified spec: read-only queries (status, log, diff, branch) plus mutating operations (stage, commit, branch, rebase, reset), with destructive/history-rewriting actions only on the user's explicit request.

## Technical Context

**Language/Version**: TypeScript ESM (NodeNext), Node >=22.13, ES2022 target

**Primary Dependencies**: Vercel AI SDK (`ToolSet`, Zod schemas), shared bounded subprocess primitive `core/process` (`runBoundedProcess`), existing workspace path helpers (`utils/path.ts`, `src/llm/tools/workspaceFile.ts`), `HazeToolError`/`structuredToolFailure` from `src/llm/tools/failures.ts`

**Storage**: N/A (operations run against the workspace's own `.git`; no haze-side persistence)

**Testing**: Vitest — `tests/hazeTools/gitTools.test.ts` plus focused `tests/llm/**` prompt-sync tests

**Target Platform**: Node >=22.13 terminal CLI

**Project Type**: CLI agent

**Performance Goals**: routine git queries return in one tool call with bounded output (default ~20 commits / ~200 diff lines) so context cost stays minimal

**Constraints**: workspace confinement (operations limited to the current workspace repository; outside refused); secret-file and git-internals protections from `core/safety` apply; outputs JSON-serializable, bounded, with `reasonCode`/`recoverable`/`suggestedNextStep` on failure; mutating git tools follow the constitution's no-confirmation-gate rule but only on explicit user request for destructive actions

**Scale/Scope**: single workspace repository per turn; no multi-repo orchestration

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 design.*

- **Expert-oriented, light guardrails (I)**: PASS — git tools never add confirmation gates; mutating git operations run when relevant to the user's explicit request, surfaced transparently in the tool transcript.
- **Public contract surfaces**: PASS — new tool names/schemas/result shapes are public contract; formatters (`formatters.ts`) and tests under `tests/hazeTools/**`/`tests/llm/**` will be updated in lockstep, and `systemPrompt.ts` stays synced with real tools.
- **Bounded, structured output**: PASS — results are compact structured summaries with truncation indicators, consistent with existing output-cap/storeToolOutput conventions.
- **Safety invariants**: PASS — secret-file refusal, git-internals protection, and workspace confinement are inherited from existing safety layers; git tools must not bypass them.

No violations; Complexity Tracking not needed.

## Project Structure

### Documentation (this feature)

```text
specs/002-git-tools/
├── spec.md            # Feature specification (/speckit-specify + /speckit-clarify)
├── plan.md            # This file (/speckit-plan command output)
├── research.md        # Phase 0 output
├── data-model.md      # Phase 1 output
├── quickstart.md      # Phase 1 output
├── contracts/         # Phase 1 output
│   └── git-tools.md   # Tool schemas and result shapes
└── tasks.md           # Phase 2 output (/speckit-tasks - NOT created here)
```

### Source Code (repository root)

```text
src/llm/
├── hazeTools.ts            # register gitTools in the built-in catalog
├── systemPrompt.ts         # standing guidance: prefer git tools over shell git
└── tools/
    └── gitTools.ts         # NEW: git tool schemas + execute (runs via core/process)

tests/
├── hazeTools/
│   └── gitTools.test.ts    # NEW: behavior, bounds, confinement, refusal cases
└── llm/                    # prompt-sync test for the git-tool guidance rule
```

**Structure Decision**: single new module `src/llm/tools/gitTools.ts` composed into `hazeTools.ts`, mirroring how `graphTools.ts` is structured; tests in `tests/hazeTools/` per the `src/AGENTS.md` test mapping.

## Complexity Tracking

N/A — no constitution violations.
