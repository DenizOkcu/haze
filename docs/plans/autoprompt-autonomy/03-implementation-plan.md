# 03 — Implementation plan: haze autonomy upgrades from autoprompt

Six phases, ordered by autonomy payoff per unit of risk. Each phase is independently shippable; earlier phases de-risk later ones (dependency graph at the end). File targets reference the current tree (2026-08-19); all changes must respect the runtime contracts in the root `AGENTS.md` and the module contracts in each touched subtree's `AGENTS.md`.

Guiding rule throughout: **port autoprompt's semantics into haze's existing enforcement skeleton** (`completionController`, `workState`, `goalSupervisor`, subagents, session store). Do not build a parallel orchestration engine.

> **Superseded plan:** P1 and P6 remain; P4 remains only as opportunistic same-check red→green evidence, without a mandatory repro, depth prompt, waiver, or successor declaration. P2/P2b, P3, and P5 were implemented, measured with Harbor, and then removed because they increased token/time cost without improving success on the tested task. The phase descriptions below are retained as implementation history, not active requirements.

---

## Phase 1 — Durable goal ledger and resume frontier

**Autoprompt mechanism:** `PROMPTS.txt` + `GATELOG.md` frontier; explicit resume reads only the tail; half-written artifacts treated as absent.
**Haze problem solved:** goals are in-memory (`GoalCheckpoint`); a crash, exit, or session switch abandons an active goal even though the conversation persists.

### Design

Persist a goal record alongside the session conversation in `~/.haze/sessions` (new `SessionEntry` kinds — see files). The record is the haze analogue of the three-file governance, deliberately **not** workspace Markdown:

```ts
interface GoalLedgerEntry {
  kind: 'goal';
  goalId: string;
  request: string;            // exact user bytes, stored once (PROMPTS.txt analogue)
  requestHash: string;        // sha256 of request bytes — completion bars bind to this
  intent: RequestIntent;
  asks?: Ask[];               // Phase 2; omitted in Phase 1
  taskCounts?: {...};         // carried evidence at boundary time
  mutationCount: number;
  validationOutcome: ValidationOutcome;
  cycle: number;
  progressSignature: string;
  stopReason?: GoalStopReason; // present on the terminal entry
  at: string;
}
```

- The supervisor (`runAgentGoal`) appends one entry per `goal_start` / `goal_continue` / `goal_end` boundary — the append-only **frontier** is the last non-terminal entry.
- On session resume, if the tail carries an unterminated goal, surface it in the resume path (system note + one-key continue, mirroring the existing R-resume UX) instead of silently starting fresh.
- Crash safety follows the session store's existing JSONL discipline: a truncated tail entry parses as absent (autoprompt's "treat half-written artifacts as absent").
- `requestHash` is the seed of Phase 2's ask binding: everything downstream that references "the mission" carries the hash.

### Files

- `src/core/session/sessionStore.ts` — new entry kinds, tail-goal detection helper.
- `src/core/session/sessionSlimming.ts` — goal entries are small metadata; ensure slimming never drops the frontier (drop superseded intermediate entries only if size demands, keep the last).
- `src/cli/commands/streaming/goalSupervisor.ts` — emit ledger appends at the three boundaries; accept `resumeFrom: {kind: 'stored-goal'}`.
- `src/cli/commands/streaming/goalCheckpoint.ts` — extend `GoalCheckpoint` with `requestHash`; keep the "safe metadata only" invariant (no commands, content, or credentials — the exact request string is user-typed text, which sessions already persist).

### Contracts to preserve

- Sessions stay memory-only until the first resumable message; goal entries must not force early persistence on their own.
- Empty/legacy files stay out of resume listings (a session whose only entry is a goal record is not resumable on its own).
- No workspace pollution: nothing under `process.cwd()` changes.

### Tests

- `tests/core/session/*` — append/read frontier, truncated tail treated as absent, slimming preserves frontier.
- `tests/cli/commands/streaming/goalSupervisor.test.ts` — supervisor decisions unchanged when no ledger; ledger written on each boundary; stored-goal resume path.
- `tests/cli/commands/streaming.test.ts` — end-to-end: crash between cycles (simulated abort) leaves a resumable frontier.

### Acceptance

- Kill a multi-cycle goal mid-run; resume the session; the goal continues from the frontier with carried evidence, without re-sending the user request.
- `git status` in the target repo shows nothing new.

---

## Phase 2 — Ask-shaped completion

**Autoprompt mechanism:** GOAL-CHECK re-derives every ask from the exact mission bytes; `prompt=gap` forces NOT-DONE even when the roadmap (task list) completed.
**Haze problem solved:** `assessCompletionReadiness` is count-shaped. A task list that omits half the request plus one green validation passes the gate.

### Design

1. **Ask extraction at goal start.** Derive 1–7 concrete, checkable asks from the request. Two-tier source:
   - Deterministic first: keep `classifyRequestIntent` heuristics for intent, but replace `createSessionGoal`'s canned `successCriteria` with request-derived asks. Extraction can be done without an extra model call: seed from the request text itself (imperative clauses) in Phase 2a; optionally a structured first-step ask-list emission (`<haze_control>`-style one-request nudge, never durable history) in Phase 2b if extraction quality demands it.
   - Each ask carries `requestHash` and is stored in the goal ledger entry (Phase 1).
2. **Ask tracking in `WorkState`.** Add `asks: Array<{id, text, status: 'open' | 'met' | 'waived', evidence?}>`. Status transitions are driven by the same structured events `observeWorkToolEvent` already consumes (validation summaries, task completions, touched files) plus explicit model marking via an extended `writeTasks`-adjacent surface — **no new prose-override channel**: a model cannot mark an ask `met` without a validating event reference or an explicit user waiver.
3. **Gate change.** `assessCompletionReadiness` gains a `pending_asks` readiness value for implement/fix/test intents: a voluntary final with open asks is rejected exactly like pending tasks, flowing into the existing `decideGoalContinuation` same-turn recovery and supervisor continuation. `describeCompletionReadiness`/`goalContinuationPrompt` text names the unmet asks (bounded, top 3).
4. **Waivers.** An ask can move to `waived` only with a reason and only via the same structured path; waived asks appear in the final synthesis line ("assumed out of scope: …"). This is autoprompt's `WONTFIX-with-reason`, made structural.

### Files

- `src/core/agent/workState.ts` — ask array, transitions, derivation inputs; extend `taskProgressFromOutput`-style parsing if asks ride `writeTasks` output.
- `src/core/agent/completionController.ts` — `pending_asks` readiness; include in `CompletionReadinessInput`.
- `src/core/agent/goalPolicy.ts` — ask extraction; updated control prompts.
- `src/llm/tools/taskTool.ts` — likely surface for ask declaration/marking (keep the flat-schema rule from `subagent/contracts.ts` in mind: no unions).
- `src/cli/commands/streaming/attemptOutcome.ts` — project ask state into evidence; `goalCheckpoint.ts` carries ask statuses (safe metadata).
- `src/cli/commands/streaming/goalSupervisor.ts` — hydrate asks on continuation turns via `goalContext` (extends `seedCarriedGoalEvidence`).

### Contracts to preserve

- Ask heuristics are hints, not hard authorization (same stance as `classifyRequestIntent`): an ask that is genuinely N/A must be waivable by the model with a reason; do not create a deadlock where a bad extraction blocks completion forever. Bounded: after 2 corrective cycles with unchanged ask status and no progress signature change, the no-progress pause fires (existing guard).
- Synthetic ask-nudges are one-request controls; never persisted as durable conversation (`requestAssembly.ts` contract).
- Old workspace `tasks.json` from unrelated turns must never block completion — asks are goal-scoped, not workspace-scoped.

### Tests

- `tests/core/agent.test.ts`, `tests/core/workState.test.ts` — ask derivation, transitions, waiver rules, `pending_asks` readiness matrix.
- `tests/cli/commands/streaming.test.ts` — voluntary final with open asks triggers continuation; all-met asks plus green validation completes; waived asks surface in synthesis.
- Regression: plan/answer intents unaffected (asks optional there).

### Acceptance

- A request asking for three things, with a task list covering one, cannot complete while two asks are open — the continuation prompt names them.
- Requesting "add X and a test for it" yields asks for both; completing X without the test keeps the goal open.

---

## Phase 3 — Independent verification slice

**Autoprompt mechanism:** author-independent G5/G6/GOAL-CHECK; blind verifier sees mission + artifact + repository, never the author's reasoning; verdict flips gates.
**Haze problem solved:** the authoring context chooses what to validate and interprets the results. The verification primitive (subagents with clean context) exists but is never load-bearing.

### Design

1. **Trigger.** Before the first accepted voluntary final of an implement/fix goal (post-validation, tasks/asks closed), the turn runs one `verify` slice: a fresh `validate`-mode subagent (existing mode map — no new mode needed in Phase 3a) dispatched with a **pointer brief**: exact request + asks (with hashes), changed-file list from `WorkState.touchedFiles`, the validation commands the author claims to have run, and an instruction to re-derive whether the asks are met by the repository state — not to re-read the conversation (it has none, by construction).
2. **Capsule contract.** The subagent returns the existing result capsule; extend the `validate` capsule with a structured verdict block (`asksMet: boolean[]`, `regressionsObserved`, `verdict: 'verified' | 'not-verified'`, bounded reasons). Malformed/absent verdict = `not-verified` (autoprompt's default-FAIL).
3. **Gate wiring.** The verdict becomes completion evidence: `not-verified` rejects the voluntary final (readiness `verification_rejected`) and enters goal continuation with the verifier's named gaps as the continuation prompt payload. One verify slice per physical turn (bounded); a second consecutive `not-verified` without progress signature change hits the existing no-progress pause — the verifier cannot create an infinite loop.
4. **Independence rules, structural.** The verify worker gets the conversation-less subagent context (already guaranteed by `subagentRunner`), a fresh project-context assembly (already the contract), and its brief excludes the author's synthesis text (dispatch-site discipline, tested).
5. **Proportionality hook (full use in Phase 5).** The trigger carries a shape/threshold check so trivial goals can skip the slice; Phase 3 ships with a conservative default (implement/fix intents with ≥1 mutation and ≥1 ask).

### Files

- `src/core/subagent/subagentRunner.ts` — verdict block parsing for validate capsules; no schema unions.
- `src/core/subagent/contracts.ts` — capsule extension.
- `src/core/agent/completionController.ts` — `verification_rejected` readiness; verdict as `CompletionEvidence` input.
- `src/core/agent/workState.ts` — record verify-verdict events.
- `src/cli/commands/streaming/attemptOutcome.ts` + `streaming.ts` — slice admission before final acceptance (mirrors the existing recovery-slice admission shape: clamps to remaining budget, never resets it).
- `src/llm/systemPrompt.ts` — `buildSubagentPrompt` gains a verifier variant (blind-review instruction set).

### Contracts to preserve

- Subagent hard caps (steps, tool calls, deadline, summary length) apply unchanged; the verify slice must fit inside them.
- Only the result capsule enters parent context — the verdict block is bounded.
- The existing mutation-serialization policy is untouched (validate mode doesn't mutate; it may run commands).
- Budgets: the slice counts against the turn-wide `TurnBudget`; recovery slices never increase budgets.

### Tests

- `tests/core/subagent/subagentRunner.test.ts` — verdict parsing, malformed = not-verified.
- `tests/cli/commands/streaming.test.ts` — verified → complete; not-verified → continuation names gaps; two no-progress verify rejections → pause.
- `tests/cli/commands/streaming/attemptOutcome.test.ts` — readiness projection.

### Acceptance

- A goal whose final claims "tests pass" but whose verify worker observes failing checks cannot complete; the continuation prompt carries the named gap.
- Author synthesis never appears in the verify brief (asserted in dispatch tests).

---

## Phase 4 — Red→green pair for fix intents

**Autoprompt mechanism:** G3.5 DEPTH-LOCK + G6 oracle discipline: issue-derived repro proven RED unpatched, GREEN after; author never dismisses a red test alone.
**Haze problem solved:** a fix landing with one green validation passes, whether or not anything ever failed. Patch-shaped fixes and self-asserting tests are invisible to the gate.

### Design

1. **Red capture.** `WorkState` already sequences mutations and validations. Add: the first `failed` validation outcome observed **before** the first mutation of a fix-intent goal is a candidate **red evidence** (command + failure summary, bounded). Record it as `redEvidence` (hash-bound to the request).
2. **Pair requirement.** `assessCompletionReadiness` for `fix` intents gains `missing_red_evidence`: a fix goal with mutations and green validation but no recorded pre-mutation red cannot accept a voluntary final. Escape hatches (structured, not prose): (a) the failure is genuinely unobservable in this environment — the model marks it with a reason, surfaced in the final synthesis (autoprompt's WONTFIX analogue); (b) user waiver.
3. **Green binding.** The completing validation must be the same command (normalized) as the red evidence or an explicit successor recorded by the model — preventing "fail test A, pass unrelated test B".
4. **Depth discipline (prompt-level, cheap).** Add to the fix-intent operating rules in `systemPrompt.ts`: before fixing, state the suspected root-cause function and one competing hypothesis; the verify slice brief (Phase 3) asks the verifier to judge whether the fix addresses a cause or a symptom. This is autoprompt's D1–D5 reduced to what survives without a dedicated prober persona.

### Files

- `src/core/agent/workState.ts` — `redEvidence` capture in `observeWorkToolEvent`; command normalization helper.
- `src/core/agent/completionController.ts` — `missing_red_evidence` readiness.
- `src/core/agent/goalPolicy.ts` — fix-intent prompt rule + waiver surface.
- `src/cli/commands/streaming/goalCheckpoint.ts` — carry red-evidence status across cycles (safe metadata: command string + status, no output bodies).

### Contracts to preserve

- Red evidence is only a *completion* requirement, never a mutation blocker — the model may explore/edit before having a repro (the pair must exist by final, not by first edit).
- `executedMutatedArtifact` and runtime-classified validation keep their existing semantics; red capture only consumes already-recorded validation events.
- No coverage-tooling dependency (explicitly rejected in the gap analysis).

### Tests

- `tests/core/workState.test.ts` — red capture ordering (fail-before-mutation counts; fail-after-mutation doesn't), command normalization.
- `tests/cli/commands/streaming.test.ts` — fix goal without red → continuation; red→green pair → complete; waiver surfaces.

### Acceptance

- "fix the login crash" landing as a code change + passing suite, with no recorded failure before the change, keeps the goal open with a named reason.
- The same fix with a captured failing repro that later passes completes.

---

## Phase 5 — Proportional goal shapes

**Autoprompt mechanism:** tier ladder (T0–T3) + framework leaves select gate paths; GOAL-CHECK is the universal floor; escalate up only.
**Haze problem solved:** one uniform loop. After Phases 2–4, verification is heavier; without proportionality, trivial goals pay for ambitious ones (autoprompt's own answer to this is its scope topology).

### Design

1. **Shape classification** (deterministic, at goal start, recorded in the ledger entry): `trivial` | `bounded` | `multi-lane` | `debug` — derived from intent, ask count (Phase 2), estimated touched-surface (ask scope hints), and conversation prefix ("rename X to Y" → trivial). Heuristics are hints: the model can escalate a shape upward at a boundary (recorded); never downward.
2. **Shape → ceremony map:**

| Shape | Ask tracking | Verify slice | Red pair | Sweep |
|---|---|---|---|---|
| trivial | asks optional | skip | n/a | n/a |
| bounded | required | once before final | if fix-shaped | n/a |
| multi-lane | required | once before final + encourages `/fleet`-style parallel subagents for disjoint asks | per fix-shaped lane (subagent capsules) | optional final sweep worker |
| debug | required | once before final | **required** | n/a |

3. **Universal floor** (autoprompt's GOAL-CHECK rule, haze-native): every mutating goal keeps post-mutation validation + zero pending tasks/asks, regardless of shape. Shapes only add ceremony; they never remove the floor.
4. UI surfacing: the shape appears in the goal status line (`formatGoalStatus`) so users see why a small fix ran light and a big feature ran heavy.

### Files

- `src/core/agent/goalPolicy.ts` — shape classification + escalation recording.
- `src/core/agent/completionController.ts` — shape-conditional readiness inputs.
- `src/cli/commands/streaming/goalSupervisor.ts` — shape recorded in ledger; multi-lane dispatch hints in continuation prompts.
- `src/cli/commands/fleetCommand.ts` — no engine changes; only prompt-level encouragement for multi-lane goals.

### Contracts to preserve

- No new orchestration engine: shapes parameterize existing mechanisms only.
- Subagent usage guidance stays advisory for multi-lane; mutation serialization is untouched.

### Tests

- `tests/core/agent.test.ts` — classification table, escalation-only rule.
- Streaming tests — ceremony matrix per shape.

### Acceptance

- A rename-sized request completes with the existing lightweight loop (no verify slice); a three-surface feature goal runs the verify slice and parallel worker hints.

---

## Phase 6 — Headless until-done supervisor

**Autoprompt mechanism:** OS-level relauncher until DONE sentinel; FINISHED / HEALTHY-LONG / TRULY-STUCK triage via frontier progress; heartbeat staleness kill; poison guard.
**Haze problem solved:** headless `haze run` has `--timeout` (goal-level deadline) but no crash-resume; a provider hiccup at hour two wastes the run.

### Design

Implement **in-process first** (haze owns its runtime, unlike autoprompt's host-CLI constraint):

1. `haze run --until-done`: wraps the goal in a bounded relaunch loop using the Phase 1 ledger — any `model-error`/`model-stream-idle`/crash-class termination with a live frontier re-enters `runAgentGoal` via `resumeFrom: {kind: 'stored-goal'}` with backoff.
2. **Poison guard:** reuse `progressSignature` — if N consecutive relaunches (default 3) show no signature movement, stop with the frontier preserved and a truthful non-zero exit (autoprompt's TRULY-STUCK). HEALTHY-LONG (frontier moving) never trips the guard; the goal deadline (`--timeout`) remains the wall-clock bound.
3. **Sentinel:** the terminal ledger entry with `stopReason: 'completed'` is the sentinel (no filesystem marker needed — the ledger is the source of truth).
4. **External wrapper (optional, later):** a `--supervisor` shell mode that re-executes `haze run --until-done` for process-level crashes (SIGKILL, OOM), with the same poison semantics reading the ledger tail. Only if in-process proves insufficient.

### Files

- `src/cli/commands/runCommand.ts` — flag parsing, relaunch loop, exit-code contract (non-zero unless structurally complete — already the headless rule).
- `src/cli/commands/streaming/goalSupervisor.ts` — stored-goal resume acceptance (from Phase 1).
- Docs: `docs/commands.html` / `docs/workflows.html` for the new flag.

### Contracts to preserve

- Unattendedness never grants authority: no commits/pushes/publishes; the supervisor resumes work, not permissions (autoprompt's explicit boundary).
- NDJSON event sink unchanged; add `goal_resume` events for observability.

### Tests

- `tests/cli/runCommand` coverage — relaunch on simulated model errors, poison stop after no-progress relaunches, deadline precedence, exit codes.
- Integration-style test with a scripted flaky model (existing streaming test harness patterns).

### Acceptance

- A headless goal that hits two transient provider failures mid-run still completes without human intervention, and a genuinely stuck goal stops after 3 no-progress relaunches with a truthful exit and a resumable frontier.

---

## Dependency graph and sequencing

```
P1 ledger/frontier ──► P2 asks ──► P3 verify slice ──► P5 shapes
      │                    │
      └────────────────────┴──► P4 red/green pair (independent of P3)
      │
      └──► P6 headless until-done (needs P1 only; better with P2)
```

- P4 is independent of P3 and can run in parallel with it.
- P5 must land after P2+P3 so it has ceremony to modulate.
- P6 needs only P1; shipping it early is fine if headless autonomy is the pressing need.

## Cross-cutting invariants (apply to every phase)

1. **No prose completion channel.** Every new readiness value (`pending_asks`, `verification_rejected`, `missing_red_evidence`) flips only on structured evidence; waivers carry reasons and surface in synthesis.
2. **Bounded everything.** Ask lists, verdict blocks, red summaries, and continuation prompts are size-capped; verify slices and relaunches count against existing budgets and never re-arm them.
3. **No workspace pollution.** All new state lives in `~/.haze` (session JSONL). Nothing appears in the target repo's `git status`.
4. **No silent model/effort routing.** Per-role model selection stays rejected.
5. **Honest reporting.** `goal_end` evidence, headless envelopes, and UI status lines must distinguish completed / paused-with-frontier / blocked truthfully — the existing goal-supervisor stance.
6. **Docs and tests move with behavior:** each phase updates the relevant `AGENTS.md` module contracts, `docs/*.html` where user-visible, and the test mapping listed per subtree before merge.

## Validation per phase

Follow the root testing expectations: `npm run typecheck && npm test && npm run lint` at minimum; targeted suites listed per phase; `npm run build && npm pack --dry-run` for anything touching packaged docs or the CLI surface (P6). Manual smoke: one interactive multi-cycle goal and one headless run per phase.
