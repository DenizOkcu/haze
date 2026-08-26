# 01 — How the autoprompt skill works

Analysis of `/Users/deniz.okcu/development/autoprompt-skill` (v1.0.0). Focus: the mechanisms that produce autonomy and failure reduction, and the failure modes each mechanism targets.

## 1. What it is

Autoprompt is an explicit-only orchestration loop delivered as a provider-specific skill package (Claude Code, Codex, OpenCode, Kilo, VS Code, Prime Agent). One invocation (`/autoprompt <mission>`) turns a mission into:

1. one stored mission ledger,
2. one independently approved executable roadmap,
3. dependency-safe parallel implementation lanes,
4. author-independent review, runtime verification, sign-off, sweep, and a goal check,

with crash-resumable state and an optional OS-level supervisor for unattended runs.

Everything below is *prompt-level*: contracts written in Markdown that the host model is instructed to follow. There is no runtime enforcement beyond what the host CLI provides.

## 2. Invocation and control surface

- **Explicit-only start.** The skill must never be inferred from an ordinary request. Loading the skill or invoking it bare reports status and stops. This prevents accidental heavy orchestration.
- **Controls are not mission text.** `mode=tokensaver|wide|custom`, `max_subs=N`, `agents=off|auto|<list>` are stripped before the mission is stored, so the stored mission bytes are exactly what the user meant.
- **One-question chooser.** In attended runs, all undefined knobs are resolved in a single ask before any repository work. In unattended runs, knobs default deterministically (`tokensaver`, `agents=off`) and the assumptions are recorded.
- **Operator overrides beat unattended defaults**, and every resolution is logged.

Failure mode targeted: heavy orchestration triggered accidentally; config interrogation polluting the mission; nondeterministic defaults in unattended runs.

## 3. Three-file governance

New-run governance is exactly three files, stored at a governance root **outside the target repository** so they never appear in the working-tree diff:

| File | Role | Discipline |
|---|---|---|
| `PROMPTS.txt` | The exact mission bytes | Append-only `=== PROMPT N ===` blocks; never rewritten; later user steering appended as new blocks |
| `ROADMAP.md` | The sole scope/decomposition/plan source | One canonical document; repaired item-by-item, never regenerated wholesale |
| `GATELOG.md` | Append-only transition log | Persona/model/effort provenance, verdicts, artifact hashes, elapsed time, and the **resume frontier** |

An explicit ban list forbids the dozen-plus governance files these protocols tend to sprout (`BRIEF.md`, `PLAN.md`, `COVERAGE.md`, `ANCHOR.md`, …).

Failure modes targeted: mission drift (the exact ask changing as it gets retold), plan-of-record ambiguity, artifact sprawl, and unresumable state after a crash. The **frontier row** in `GATELOG.md` (mission pointer/hash, nonce, last accepted gate, open item ids) is the entire resume state — the resuming context reads only the log tail.

## 4. Compact pointer briefs

The mission is stored once. Every later worker receives a *MISSION POINTER*:

```text
MISSION POINTER: read the exact prompt ledger before acting; stop if its hash or byte length differs.
path=<PROMPTS.txt> hash=sha256:<64 hex> bytes=<UTF-8 byte length> nonce=<RUN-NONCE>
```

The worker verifies path, hash, byte length, and nonce before acting; mismatch is a terminal `INVALID-BRIEF`. Briefs carry only role, objective, owned boundary, dependencies, acceptance criteria, roadmap-section pointer, evidence pointer, output schema, and truthful model/effort status. Full transcripts, doctrine, and prior adversarial reasoning are never pasted.

Failure modes targeted: context bloat in fan-out, mission corruption across retellings, and — critically — **contaminated blind review**: a reviewer who has read another reviewer's verdict or the author's reasoning is no longer independent.

## 5. Hierarchy and dispatch

Five levels, strict dispatch contracts:

- **L0 conductor** — starts the run, reports the verdict. Dispatches only named L1 coordinators; spawning a worker directly is a "skip-the-coordinator collapse".
- **L1 coordinators** (scope / feature / sweep) — own a domain's state, dispatch only, never read/write/run.
- **L2 manager** — optional, multi-feature slices only.
- **L3 executors** — scoper, researcher, synthesizer, planner, implementer, reviewer, verifier, sweeper.
- **L4 leaves** — fresh-verifier, depth-prober, framework-validator, juror, goal-checker, arbiter, re-anchor, scribe, janitor.

Rules with teeth:

- Every dispatch binds a registered `ap-*` persona by name; anonymous or invented agents are invalid.
- **Spawn-all-then-collect**: every spawn of a ready disjoint group is issued before any report is collected; serialization only for declared real dependencies.
- **Collect-then-stop**: an agent is stopped once its final report is collected; parked agents still count against the live ceiling; DONE requires zero live subagents.
- Never duplicate live ownership; a worker that cannot fit its boundary returns a split request rather than recursing.
- No read-relay agents; coordinators read what they need themselves.
- Workers may never load or re-invoke the skill (no nested runs).

Failure modes targeted: unowned or double-owned work, idling parked agents, context-relay overhead, runaway recursion.

## 6. Gates

The gate ladder (tier-dependent subset):

| Gate | Persona | Function |
|---|---|---|
| G1 PLAN | `ap-planner` | Focused plan with TDD sequence; for debug, a falsifiable root-cause hypothesis + ≥2 competing causes + fix layer named `file::function` |
| G2 PLAN REVIEW | `ap-reviewer` | Independent plan review (PASS/SMASH with numbered reasons) |
| G3 FRESH VERIFY | `ap-fresh-verifier` | Blind, default-REJECT check of the candidate against the mission and the real repository |
| G3.5 DEPTH-LOCK | `ap-depth-prober` | Debug only; see §7 |
| G4 IMPLEMENT | `ap-implementer` | Strict TDD: failing test → RED captured → minimum change → refactor green → touched modules + dependents → ≥95% changed-line coverage |
| G5 IMPL REVIEW | `ap-reviewer` (≠ implementer) | Every claim matched to file:line evidence |
| G6 VERIFY | `ap-verifier` (≠ author) | Runs the real oracle: fail-to-pass test RED on unpatched and GREEN after; pre-existing suites re-run; green-to-red regression is a hard failure |
| G7 SIGN-OFF | `ap-juror` panel | Fresh binary verdict(s); unanimous; a P0/P1 finding cannot be arbitrated into PASS |
| G8 SCRIBE | `ap-scribe` | Append-only ledger recording; never evaluates |
| SWEEP | `ap-sweeper` | Fresh production-readiness pass: re-derive asks, inspect changed neighborhood, dedup'd P0–P3 findings |
| GOAL-CHECK | `ap-goal-checker` | See §8 |

Scope itself is gated: a bounded mission gets **3 agents / 2 rounds** (author → concurrent reviewer + fresh verifier, target <1 min); multi-surface gets **exactly 5 agents / 3 rounds**; "unusually large" requires a recorded escalation reason. Review failure repairs only named items — never a wholesale scope rerun.

## 7. The debug depth lock (G3.5)

The most distinctive mechanism. For every bug fix, before implementation, a blind prober (unaware of the proposed fix) derives:

- **D1** the home function where the behavior is decided;
- **D2** a whole-contract input-class table, including the issue-derived gold-revealing class;
- **D3** the *deepest* `file::function` whose correction fixes all D2 classes (symptom-layer candidates are marked `SHALLOW`);
- **D4** an adversarial hidden-oracle repro derived from the issue text (never phrased in terms of the patch mechanism), **run against unpatched code with real RED output captured**;
- **D5** verdict: PASS only if the frozen fix layer equals D3 and D4 is proven RED unpatched.

The issue text — not a proposed mechanism — defines the behavioral oracle. The author never dismisses a red test alone; that requires independent adjudication.

Failure mode targeted: patch-shaped fixes. A test that asserts the patch's own mechanism is "green coverage over a self-written repro", not acceptance.

## 8. GOAL-CHECK: completion as adversarial re-derivation

A fresh, author-independent leaf, **default NOT-DONE**. It re-derives every ask from the exact mission text alone and checks each against opened evidence. DONE requires all of:

- every mission and roadmap ask evidenced complete;
- zero open findings at *any* severity (minor flaws included);
- user-usable through a real entry point;
- no pre-existing green-to-red regression;
- ≥95% changed-line and touched-module coverage;
- a real end-to-end exercise covering the **tri-axis**: scope ∪ original prompt ∪ potential flaws, with a machine line `E2E: scope=… prompt=… flaws=N ran=…`;
- ledger provenance reconciles;
- zero live subagents.

The tri-axis matters: `prompt=gap` catches a *too-small scope* — the roadmap finished, but the user asked for something the roadmap never included. Verdict prose never overrides structured negative evidence.

## 9. Independence rules

- No agent reviews, verifies, signs off, or goal-checks work it authored — "the independent-verification floor never collapses with fan-out width".
- Concurrent blind assurance agents (e.g. G2 ∥ G3, G5 ∥ G6) **share no verdict channel**: neither reads the other's ledger rows before reporting.
- Verification must exercise the actual graded oracle (fail-to-pass), not pre-patch suites or roadmap-conformance checks — otherwise `NOT-VERIFIED`.

## 10. Resume, steering, arbitration

- **Resume is explicit** — only an explicit `resume` or supervisor relaunch; artifacts on disk never auto-resume. The resuming context reads only the `GATELOG.md` tail; workers (not the resumer) re-read their own roadmap sections and evidence, verifying pointer hashes. Half-written `.tmp`/empty/unparsable artifacts are treated as absent. Valid evidence is reused; only incomplete/rejected gates rerun.
- **Steering** is appended to `PROMPTS.txt` as new blocks. Urgent steering is routed to affected lanes; additive steering queues at the next dependency boundary; unaffected lanes keep running; accepted evidence is never abandoned because a steer arrived.
- **Arbitration**: an `ap-arbiter` decides technical forks and continues — including unattended. The user is asked mid-run only for genuinely user-owned calls: irreversible/destructive actions, real money/quota, credentials only the user holds, product direction. Arbitration can never waive capability failure, open P0/P1 blockers, coverage, or real verification.

## 11. External supervisor

A standalone OS process (`workflow/supervisor.sh|.ps1`) — not a hook — that:

- relaunches the host CLI with the mission after unexpected exits, with backoff;
- loops until the janitor's DONE sentinel (`DONE-<nonce>`, written atomically via `.tmp` + rename) appears;
- distinguishes **FINISHED** (sentinel) / **HEALTHY-LONG** (frontier still advancing → keep relaunching) / **TRULY-STUCK** (no frontier progress in the window → poison guard, stop);
- heartbeat-monitors frontier-count staleness on a live child (long tool call guard) and kills-and-relaunches;
- grants no permissions: verification and ledger recording never imply publication authority.

## 12. Proportionality

Ceremony scales with risk: 14 framework leaves route category×tag×tier to a declared gate path (`apply` gets `APPLY → DIFF-REVIEW → VERIFY-GREEN`; `backend-fix` gets the full debug ladder). GOAL-CHECK is the universal floor. Escalation up a tier is allowed when redo budget is spent or reality reveals broader scope; de-escalation of completed depth never happens. A selector miss routes through framework *generation and validation* rather than proceeding unframed.

## 13. Why it works (mechanism → effect)

| Mechanism | Effect |
|---|---|
| Exact mission bytes, stored once, hash-verified | The completion bar cannot drift from what was asked |
| Append-only ledger + frontier | Crash-safe autonomy; no silent state loss or history rewriting |
| Author-independent verification + blind channels | Catches self-confirmation, the dominant long-run failure |
| Red-before-green oracle discipline | Kills patch-shaped fixes and "tests that assert the patch" |
| Default-FAIL gates with structured verdicts | Prose optimism cannot complete work; only evidence flips a gate |
| Proportional tiers | Failure-prone work gets ceremony; trivial work stays cheap |
| Collect-then-stop, bounded concurrency | No idling agents, no runaway fan-out |
| Explicit user-boundary list | Autonomy without authority creep (no commits/deploys/spend by default) |
| Frontier-progress poison guard | Unattended runs halt instead of burning money in a loop |
