# Model steering in Haze: case study and improvement plan

## Scope and evidence

This review uses a recorded session (`~/.haze/sessions/edf44bc32170f24c/2026-09-26T08-41-17-131Z-8720b0.jsonl`), the resulting project checkout, and Haze source at commit `a2f3d3e` (version 1.4.0). The session ran `gpt-5.6-sol` with high reasoning and a reported 400,000-token context window. There are no `~/.haze/logs` debug files for this run; the JSONL session is the available execution record. This is one case study, not evidence that every model or project behaves the same way.

The model did useful work. It researched the project's three model cards, recognized that these are ingredient embeddings rather than a generative language model, built a local model service and Koa API, fixed failing API tests, assembled a React frontend, and verified a live Compose stack. The final Nginx image builds the frontend and copies its artifacts into `/usr/share/nginx/html`. The later user request about Nginx described behavior already present in the checkout.

| Observation | Evidence | Steering implication |
| --- | --- | --- |
| The first backend attempt stopped with two API tests failing and two tasks in progress. The goal ended `failed/blocked` at a tool boundary at 08:51:40; a later resume repaired the middleware and completed at 08:56:50. | Session `turn_end` and `goal_end` events at those times; failed `cd api && npm test` calls | Budget boundaries should preserve a resumable, specific next action and continue when recovery is possible. |
| The backend request was classified as `test` because it included “run locally.” The React request was classified as `unknown` because “build” is absent from the implementation verb list. `commit` and the later Nginx request were also `unknown`. | Goal ledger `intent`; `src/core/agent/goalPolicy.ts` keyword rules | Intent must reflect the user's requested action, with tool and mutation evidence able to strengthen the completion policy. |
| The frontend goal ended `complete` at 09:18:50 while its turn evidence still said `validationOutcome: failed`. All five tasks had just been marked complete. | Session `turn_end` and `goal_end` at 09:18:50 | Completion must never ignore unresolved validation merely because intent was `unknown` or tasks were checked off. |
| The backend's terminal goal-ledger entry said `complete` but retained `validationOutcome: failed`, 28 mutations, and two tasks in progress. The adjacent `turn_end` event said validation passed, 30 mutations, and all tasks complete. | Session goal-ledger entry and `turn_end` event at 08:56:50 | Persist terminal evidence from the final turn rather than a stale checkpoint. |
| A frontend build first failed as `cd frontend && npm run build`, then passed as `npm --prefix frontend run build`. Haze retained the former failed check; later generic checks could not clear it. | Session shell results at 09:15:01, 09:16:10, and 09:17:xx; `deriveValidationOutcome` in `src/core/agent/workState.ts` | Track the check's project and purpose, not only its literal command string or the last generic result. |
| The backend made 24 file-mutation calls before its first validation; the frontend made 38 before its first validation. The frontend reached 131,457 input tokens on a later step. | Session tool and step events | A smaller model needs shorter implementation slices, earlier checks, and a compact project state. |
| Frontend tests exercise three label helpers. The live smoke test checks HTTP, assets, API, and model inference; it does not click through the main user flow. | the project's `frontend/src/lib/utils.test.ts`; session smoke command at 09:18:03 | A passing build and HTTP smoke test do not establish that the visible user workflow works. |

The session's first API test failures were real and repaired. The first Nginx syntax failure was caused by testing a config that referenced Compose DNS outside that network; a later check supplied a host mapping and passed. The root `npm test` failure came from running in a directory without a root package script; `npm --prefix api test` then passed. These are ordinary recoverable mistakes. Haze's weakness was that it did not consistently convert such failures into concise, scoped work to finish before reporting completion.

## How Haze steered this run

1. `src/llm/systemPrompt.ts` gave broad operating rules: inspect, edit, validate, use `writeTasks` for substantial work, and report honestly. It encouraged batching independent tool calls and concise final answers.
2. `src/core/agent/goalPolicy.ts` inferred request intent with regular expressions. That intent selected success criteria and helped decide whether validation was mandatory.
3. Tools returned structured results. `src/core/agent/workState.ts` recorded changed files, task counts, validation commands, and failure evidence. `src/core/agent/completionController.ts` used that state to accept or reject a final answer.
4. One-request `<haze_control>` prompts narrowed tools, repaired malformed calls, or told the model to continue when a final was premature. `src/cli/commands/streaming/goalSupervisor.ts` carried goal checkpoints across physical turns.
5. The active conversation retained long tool history until the model-aware context threshold. This run stayed below its 400,000-token window, so the frontend goal accumulated more than 130,000 input tokens without a compaction event.

This is a useful base: structured tool outcomes, bounded recovery, and durable goal checkpoints already exist. The main gaps are the meaning assigned to a user request, the identity and scope of validation evidence, and the amount of work left for the model to organize unaided.

## Implementation plan

### P0 — Make completion evidence trustworthy

**1. Replace keyword-only intent with a small goal contract.** Parse the request into an action, target artifact, explicit constraints, and observable completion checks. Keep the parser deterministic and inspectable; use a model only to propose ambiguous checks, then validate them against tool capabilities and the request. Make `build a React frontend`, `make models run locally`, and `commit` distinct cases. When source mutations occur during an `unknown` request, require post-mutation validation unless the user explicitly asked only for a plan, review, or answer. Never let the intent classifier alone authorize a successful final.

**2. Track validation per project and check.** Store check identity as `{workingDirectory, package/workspace, script or executable, check kind}` plus the exact command, exit status, and mutation sequence. Normalize safe equivalents such as `cd frontend && npm run build` and `npm --prefix frontend run build`; avoid treating unrelated commands as equivalent. A failed check remains open until an equivalent check passes after the relevant edit. A generic check cannot hide an unresolved test, typecheck, lint, or build failure. A newer passing build should clear an older equivalent build failure, even when shell spelling differs.

**3. Make the goal gate authoritative across physical turns.** Carry open checks, task counts, and the next concrete action in the checkpoint, not just one last validation outcome. If a budget boundary arrives with recoverable failed tests, keep the goal resumable and continue while the deadline and progress policy permit. A terminal `complete` event must satisfy the same invariant as the final user message. Write its ledger row from final turn evidence rather than the previous checkpoint, and record the exact gate decision and evidence IDs for auditability.

**Acceptance:** Replay this session's backend and frontend event sequences. The backend pauses or continues at the first boundary with its two failing tests named, then completes after they pass. The frontend cannot complete with a failed validation in its evidence. Equivalent build reruns resolve the old failure. The terminal ledger agrees with the final turn's mutation, task, and validation evidence. Add direct tests in `tests/core/agent/goalPolicy.test.ts`, `tests/core/workState.test.ts`, `tests/core/completionController.test.ts`, and `tests/cli/commands/streaming/goalSupervisor.test.ts`, plus a full event-replay regression.

### P1 — Give the model a small, explicit mission

**4. Build a requirement ledger before large edits.** For substantial implementation requests, extract a short list of user-visible requirements and concrete checks. For that project, that would have included all three local models, Koa API capability coverage, Compose services, Nginx static frontend delivery, two user flows, and relevant tests. Link each requirement to files and evidence as work proceeds. Surface unresolved requirements at checkpoints and in the final gate. Allow the model to revise the ledger when research changes its understanding, with a recorded reason. Keep ordinary small edits free of this overhead.

**5. Work in vertical slices.** Before generating dozens of files, produce one runnable path and validate it: one model endpoint through Koa and Compose, then the remaining operations; one frontend flow through the API and Nginx, then the second. After each slice, run the smallest authoritative check and update the ledger. Tool affordances should make this easier than writing 30–40 files before the first build. Limit independent write batches to files whose contracts are already known; dependent files and tests belong in subsequent steps.

**6. Match tests to the requested outcome.** Recommend a contract test for every public API operation claimed as covered. For a frontend request, check at least one real user interaction, including loading and error states, with a browser runner when available. If it is unavailable, state the specific coverage gap; do not silently equate HTTP smoke with a browser flow. Add a requirement-specific final review that checks terms such as “shadcn design system” against the actual implementation and reports a deliberate interpretation such as “shadcn-style primitives.”

**Acceptance:** On a fresh task of the same shape, Haze reports the requirements and their evidence, validates a first runnable path before bulk file generation, and cannot mark a requested UI flow verified solely from utility tests or asset HTTP responses. Test the extraction and gating on both broad greenfield work and small edits so the latter stay quick.

### P1 — Make smaller and cheaper models effective

**7. Add an explicit compact execution profile.** Select it by user setting or a measured capability probe; never silently switch providers or models. Cap each working slice to a few files, expose only tools needed for the current phase, use short schemas and compact tool results, and reserve context for errors and the next check. Ask for one structured action at a time when a provider struggles with parallel tool calls or large JSON arguments. Preserve the same completion rules across profiles.

**8. Maintain a compact, durable project state.** After each slice, store a bounded summary of requirements, decisions, changed files, open checks, and the next action. Rehydrate that state plus targeted file reads instead of replaying the full transcript. Keep exact command outcomes and unresolved failures as structured data; summarization must not turn a failure into a pass. Trigger compaction by the effective model's usable context budget and observed input growth, before the provider rejects a request. Test at 8k, 16k, and 32k windows as well as large hosted windows.

**9. Give weak models guardrails through tooling.** Provide a deterministic project preflight (package scripts, directories, Git state, relevant instructions), scoped command suggestions, normalized validation results, and actionable repair hints for common build errors. Prefer small bounded edits over generating large files in one call. If the model repeats a failed action, show the last failure and an allowed next step. Keep the model responsible for design choices, while Haze handles bookkeeping and routine evidence checks.

**10. Escalate only with explicit policy.** Let a user opt into a stronger model for ambiguous architecture, repeated no-progress cycles, or context exhaustion. Pass a compact task capsule with evidence and remaining requirements; do not transfer huge raw transcripts. Report which model did the work and the estimated extra cost where available. Do not promise identical creative quality from every local model; measure whether the same functional acceptance criteria are met.

**Acceptance:** A configured local OpenAI-compatible model can finish a bounded implementation slice within its context window without dropping constraints or falsely claiming a passing check. Compare completion rate, requirement coverage, incorrect completion rate, tool calls, wall time, tokens, and user-rated quality against the current profile. Explicitly count escalations.

### P2 — Improve observability and evaluation

**11. Add a safe session review report.** Generate a concise timeline from the existing JSONL: model and reasoning setting, intent/goal contract, phase and tool counts, validation failures and resolutions, budget boundaries, context size, continuations, and final evidence. Store only bounded metadata by default; redact command arguments and paths that may contain secrets. Avoid duplicate full conversation snapshots when an append-only delta or periodic checkpoint would suffice. This run wrote several nearly identical ~650 KB snapshots near the end.

**12. Build a replay and outcome eval suite.** Turn the recorded traces into deterministic tests using stubbed tool results. Include misleading phrases (`run locally`, `build`, `commit`), equivalent command forms, a failed authoritative check followed by a generic success, a budget boundary with unfinished tasks, and a UI request with only utility tests. Add fresh tasks from other repositories to avoid fitting solely to one project. For live model evals, run the same acceptance tests with a strong baseline and selected cheaper/local models; compare quality and cost without using the model's final prose as the success signal.

**Acceptance:** `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build` pass. A review command explains why each replayed goal completed or paused. No replay ends `complete` with unresolved authoritative failures or missing required checks. Track false completion rate as the primary release gate, then completion rate, time, token use, and cost.

## Suggested delivery order

1. Land intent, validation-identity, and ledger regressions with the recorded event replay. These close the observed unsafe completion path.
2. Add the requirement ledger and phase-specific checks to improve task fidelity and shorten repair loops.
3. Add the compact profile and bounded project state, then evaluate 8k–32k local models against the same acceptance suite.
4. Add the session report and storage improvements once the new evidence fields are stable.

Keep these changes behind small interfaces in `core/agent` and `core/validation`; let CLI and UI display structured decisions rather than reimplementing them. Update `src/core/agent/AGENTS.md`, the relevant CLI guidance, and user docs when the runtime contract changes. No changes to that project's source are needed to carry out this Haze plan.
