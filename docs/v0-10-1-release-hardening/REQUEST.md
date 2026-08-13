# v0.10.1 Release Hardening Request

## Original request

Convert the comprehensive v0.10.1 pre-release review findings into Markdown artifacts that a fresh AI coding agent can use to implement the fixes.

## Repository state at handoff

- Package version: `0.10.1`
- Branch: `main`
- Reviewed commit: `c88da79` (`Fix edit recovery and prepare 0.10.1`)
- Branch state before creating these artifacts: one commit ahead of `origin/main`
- Product source was not modified during the review or this handoff.

## Objective

Make long-running Haze turns predictable and bounded, remove avoidable performance cliffs, and restore confidence in the default release gate. Preserve existing safety boundaries and user-facing behavior unless a documented contract change is required.

## Priorities

1. Resolve the release-blocking test instability and `listFiles` N+1 process design.
2. Enforce tool-call and runtime limits at execution boundaries.
3. Make context budgeting account for the selected model and the complete request.
4. Prevent quadratic stream output and other long-session growth paths.
5. Address lower-priority transcript, LSP, session, and subagent throughput issues in isolated follow-up changes if they are too risky for 0.10.1.

## Constraints

- Follow root and nested `AGENTS.md` contracts for every subtree touched.
- Do not edit generated `dist/` output.
- Preserve strict TypeScript, ESM `.js` imports, and existing formatting.
- Avoid broad refactors or dependency changes unless a task requires them.
- Preserve malformed-settings failures and unknown settings fields.
- Preserve workspace confinement, ignore handling, output bounds, process-tree teardown, session slimming, and explicit provider/model selection.
- Add deterministic regression tests for every behavioral fix.
- Do not solve timing failures only by raising test timeouts when a known algorithmic bottleneck exists.

## Acceptance criteria

- `listFiles` does not start one Git subprocess per entry and later cursor pages do not become progressively slower through full retraversal.
- The default `npm test` command passes reliably under CI-like parallel load.
- Main-turn and recovery-slice tool-call limits cannot be exceeded by one parallel model batch.
- A hung tool cannot keep a headless or interactive turn alive forever; cancellation and teardown remain bounded.
- Request budgeting includes system prompt, tool schemas, messages, and output reserve, with a safe path for smaller local-model context windows.
- `stream-json` output is linear in generated text size, honors stdout backpressure, and has a documented event contract.
- Any deferred findings are recorded with an owner/release target instead of silently omitted.
- Final validation passes: typecheck, full tests, lint, build, AGENTS stamp check, audit, and package dry run.
