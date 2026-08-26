# 02 — Gap analysis: haze today vs. autoprompt mechanisms

Mechanism-by-mechanism comparison. Haze code references are to the current tree as of 2026-08-19. "Haze already has (stronger)" means the property is enforced structurally in TypeScript, where autoprompt can only state it as Markdown doctrine.

> **Historical note:** The later implementation and Harbor A/B retained P1 and P6, simplified P4 to opportunistic same-check red→green evidence, and removed P2/P2b, P3, and P5 because the measured ceremony added substantial cost without improving success on the tested task. This document preserves the original decision inputs; it does not describe the current runtime.

## Legend

- ✅ **Have (stronger)** — haze enforces it structurally; autoprompt states it as prompt rules.
- ⚠️ **Partial** — some of the property exists; named gap remains.
- ❌ **Missing** — no haze equivalent today.
- 🚫 **Reject** — deliberate non-adoption, with rationale (bottom section).

## Mechanism comparison

### 1. Mission fidelity — exact ask survives the whole run

| Autoprompt | Haze today |
|---|---|
| `PROMPTS.txt`: exact mission bytes, append-only, SHA-256 + byte length + RUN-NONCE verified by every worker | ⚠️ The request string is carried in the conversation and in `GoalCheckpoint.request`; compaction (`compaction.ts`) preserves recent messages but the *exact* ask is subject to conversation-level summarization over long goals; nothing hash-binds the completion bar to the original bytes |

Gap that matters: over a many-cycle goal, "what the user asked" is re-derived from a compacted transcript. A completion decision made against a drifted mission is structurally indistinguishable from a correct one.

### 2. Completion gating — prose can never finish work

| Autoprompt | Haze today |
|---|---|
| GOAL-CHECK: default-NOT-DONE fresh leaf re-derives **every ask** from the mission text; tri-axis (scope ∪ original prompt ∪ flaws); zero open findings at any severity; `E2E:` machine line | ✅+⚠️ `assessCompletionReadiness` (`completionController.ts`) is code-enforced: `pending_tasks`, `validation_failed`, `validation_stale`, `validation_absent_after_mutation`, `tool_failure`, `unresolved_tool_input`. Prose cannot complete a turn. **But** the gate is *count-shaped*, not *ask-shaped*: it checks declared task counts and the mutation→validation sequence. It never re-derives what the user asked. A model that writes a task list missing half the request, then completes that list and runs one validation, passes the gate. This is exactly autoprompt's `prompt=gap` failure class |

Also note: `createSessionGoal` (`goalPolicy.ts`) generates **canned** `successCriteria` per intent class — the same four strings for every "implement" request. They feed `workStatePrompt` display only. No per-request asks exist anywhere in the completion path.

### 3. Independent verification — the author never grades their own work

| Autoprompt | Haze today |
|---|---|
| G5/G6/G7/GOAL-CHECK are author-independent by construction; blind assurance agents share no verdict channel; "verification must exercise the actual graded oracle" | ❌ The context that authored the work also runs the validation and writes the final synthesis. Subagents (`subagentRunner.ts`) exist with clean context isolation, but nothing ever wires a subagent into the completion decision. The runtime-classified `purpose=validation` shell evidence is real process output, but the *choice* of what to validate and the *interpretation* of results both come from the authoring context |

This is the single biggest divergence. Autoprompt's benchmark story rests on independent re-derivation; haze has the primitive (subagents) but not the wiring.

### 4. Debug discipline — red-first, root-cause depth

| Autoprompt | Haze today |
|---|---|
| G3.5 DEPTH-LOCK: D1 home function, D2 input-class table, D3 deepest cause, D4 issue-derived oracle proven RED on unpatched code, D5 layer match; author never dismisses a red test alone | ⚠️ `workState.ts` tracks mutation/validation **sequence numbers** (`deriveValidationOutcome`: passed/failed/stale/absent), so "validated after mutation" is enforced. But there is no red→green *pair* requirement for `fix` intents: a fix that lands with a single green validation passes, whether or not anything ever failed first. No depth hypothesis, no competing causes |

### 5. Durable, resumable autonomy — the frontier survives crashes

| Autoprompt | Haze today |
|---|---|
| `GATELOG.md` append-only frontier; explicit resume reads only the log tail; half-written artifacts treated as absent; OS supervisor relaunches until DONE sentinel with a poison guard | ⚠️ Sessions are JSONL under `~/.haze/sessions` and resume/fork well for *conversation*. Goals are in-memory: `GoalCheckpoint` (`goalCheckpoint.ts`) carries safe metadata (reasons, counts, enums) on `TurnResult.resume`, and the interactive R-key resumes within the process. A crash, exit, or session switch loses the active goal; a resumed session starts a fresh goal from the user's next message. No sentinel, no external relauncher for headless `haze run` |

### 6. Steering mid-run

| Autoprompt | Haze today |
|---|---|
| Steering appended to `PROMPTS.txt` as new blocks; urgent → affected lanes; additive → next boundary; unaffected lanes keep running | ✅ (interactive) The turn loop is synchronous per user message; steering naturally becomes the next turn and the goal supervisor continues the preserved conversation. Gap is headless-only: a `haze run` goal in flight has no way to receive steering short of cancel |

### 7. Proportionality — ceremony scales with risk

| Autoprompt | Haze today |
|---|---|
| T0–T3 tier ladder + 14 framework leaves with declared gate paths; GOAL-CHECK universal floor; escalation up only | ⚠️ `classifyRequestIntent` (regex heuristics: implement/fix/test/review/plan/answer) already differentiates *some* behavior (e.g. `rescueEligibleRequest`, plan-only mutation caution). But every implement/fix goal runs the identical loop with identical ceremony. No notion of goal size/shape selecting verification intensity |

### 8. Concurrency and worker lifecycle

| Autoprompt | Haze today |
|---|---|
| Live-agent ceiling; spawn-all-then-collect for disjoint work; collect-then-stop; DONE requires zero live subagents; never duplicate live ownership | ✅ (stronger, different trade-off) `SubagentCoordinator` enforces admission in code: mutation workers serialized via the workspace mutation policy (RH-lineage), read-only bypass, quarantine for abort-ignoring executions, bounded caps enforced per tool execution. `/fleet` is an ephemeral parallel wrapper. Mutation serialization is deliberately more conservative than autoprompt's parallel implement lanes — keep it |
| Anonymous/persona-bound dispatch validity; registered-name contract | ⚠️ The subagent schema is a flat `objective/deliverable/mode/scope/acceptanceCriteria` object — deliberately simple (union schemas break local OpenAI-compatible models). No role/persona concept; the *mode* map (inspect/research/implement/validate) is the closest analogue and is fine. What's missing is not personas, it's a **`verify` role wired to completion** (see #3) |

### 9. Authority boundaries

| Autoprompt | Haze today |
|---|---|
| Never commit/push/publish/deploy/spend/delete without explicit authorization; arbitration can't waive blockers | ✅ (stronger) Secret files are refused in the file tools before filesystem access (lexical + real path); URL safety fails closed; mutations confined to cwd; bless set is read-only. The system prompt keeps shell-side rule alignment (`SECRET_FILE_RULE`). Autoprompt's no-commit-by-default rule is prompt-level only |

### 10. Model/effort routing

| Autoprompt | Haze today |
|---|---|
| `agents=` routing with truthful capability reporting (`selectable`/`inherited-only`/`unsupported`/`unknown`) | 🚫 Deferred deliberately. Haze's runtime contract is explicit provider/model selection with no silent fallback; per-role model routing would reintroduce exactly the silent-default class the contract forbids. A single `--verify-model` style *explicit* override could be revisited later, but it is not in this plan |

### 11. Ledger provenance — who did what, auditable

| Autoprompt | Haze today |
|---|---|
| `GATELOG.md`: every transition with persona/model/effort, verdicts, artifact hashes, elapsed time | ⚠️ Structured `agentEvent`s exist (`events.ts`: `goal_start`, `goal_continue`, `goal_end`, `timeout`, `retry`, …) and are persisted in sessions; the `--debug` LLM log exists. But there is no per-goal append-only audit trail binding evidence (which commands, which files, which verdicts) to a durable, human-readable artifact |

## Where haze is already ahead

Worth stating plainly, because it shapes what we should *not* copy:

1. **Structural completion gating.** Autoprompt trusts the model to run its gates in order and honor default-FAIL verdicts. Haze's `decideTerminalStatus`/`assessCompletionReadiness` cannot be argued out of by prose. Autoprompt's whole gate apparatus is an attempt to approximate, in Markdown, what haze already has in `completionController.ts`.
2. **Budgets, abort, and teardown.** Turn-wide `TurnBudget`, recovery slices that never re-arm caps, abort-cause distinction, quarantine of abort-ignoring attempts with exactly-once resource teardown — autoprompt has no equivalent; its supervisor just kills and relaunches the CLI.
3. **Safety.** Secret-path refusal (pre-FS, symlink-proof), cwd confinement, fail-closed URL policy — all code-level.
4. **Provider pragmatics.** Flat subagent schemas and string-only `tool_choice` workarounds reflect hard-won compatibility with local OpenAI-compatible servers; autoprompt's richer per-provider configs assume first-class hosts.

The correct posture is therefore: keep haze's enforcement skeleton, and port autoprompt's *content* — what the gates actually check — into that skeleton.

## Rejected adaptations

| Idea | Why rejected |
|---|---|
| 25-persona L0–L4 hierarchy | Haze's single-context + disposable-worker model is a feature: fewer dispatch contracts, no persona zoo, no skip-the-coordinator failure class. Independence (the actual goal) is achievable with one `verify` role. Autoprompt needs the hierarchy because its host CLIs have no completion gate; haze does |
| Governance Markdown files in/near the workspace | Violates haze's do-not-pollute-working-tree instincts and the file-tool confinement model. Goal state belongs in `~/.haze` (sessions already live there), as JSONL — machine-verifiable, invisible to `git status` |
| ≥95% changed-line coverage hard floor | Requires coverage-tooling integration per language and would block completion in repos without coverage infrastructure. Autoprompt can state it because it never has to compute it. Adopt as prompt-level guidance at most; never a structural gate |
| Per-role model/effort routing | Conflicts with the explicit provider/model contract (no silent fallback, no default provider). Truthful-effort reporting is nice; routing is out |
| 14-framework leaf library | Over-fit to autoprompt's benchmark shape. Three or four goal shapes (trivial / bounded / multi-lane / debug) capture the proportionality value at a fraction of the surface |
| Framework generation/validation personas | Solves a problem haze doesn't have (runtime framework registry). The analogous haze need — intent classification quality — is a small heuristic upgrade, not a subsystem |

## Priority ranking of the real gaps

1. **Ask-shaped completion** (#2) — highest autonomy payoff; the gate exists, its inputs are just count-based.
2. **Independent verification** (#3) — highest quality payoff; the primitive exists, the wiring doesn't.
3. **Durable goal frontier** (#5) — unlocks crash-safe long autonomy and the headless supervisor.
4. **Red→green pair for fixes** (#4) — cheap to add to existing sequence tracking; kills patch-shaped fixes.
5. **Goal shapes** (#7) — keeps costs proportional once 1–3 make verification heavier.
6. **Headless until-done** (#5b) — builds on 3; small once the frontier is durable.
