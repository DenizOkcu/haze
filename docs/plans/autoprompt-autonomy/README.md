# Autonomy plan: learning from the autoprompt skill

Last analyzed: 2026-08-19 · Source: `/Users/deniz.okcu/development/autoprompt-skill` (v1.0.0, MIT) · Target: haze autonomy stack

## What this is

A study of how the [autoprompt skill](https://github.com/Spielewoy/autoprompt-skill) achieves autonomy and failure reduction (claims 45% fewer failures on Terminal-Bench 2.1 for OpenCode + DeepSeek), and a phased plan for adapting its strongest invariants into haze's runtime — as **structural mechanisms**, not prompt doctrine.

The core thesis: autoprompt is a pure prompt-level protocol running on top of host CLIs (Claude Code, Codex, OpenCode, …). Everything it enforces, it enforces by instructing the model in Markdown. Haze already enforces several of the same properties in TypeScript (evidence-gated completion, budgets, abort quarantine). Where autoprompt proves a mechanism is *worth* enforcing, haze can enforce it *better* — deterministically, in code.

## Documents

| File | Contents |
|---|---|
| [`01-autoprompt-analysis.md`](01-autoprompt-analysis.md) | How the skill actually works: invocation, governance files, hierarchy, gates, independence rules, resume, supervisor. The mechanisms, their rationale, and their failure-mode targeting. |
| [`02-gap-analysis.md`](02-gap-analysis.md) | Mechanism-by-mechanism comparison with haze today (`runAgentGoal`, `completionController`, `workState`, subagents, sessions). What haze already has (often stronger), what is missing, and what we deliberately reject. |
| [`03-implementation-plan.md`](03-implementation-plan.md) | Six phased work packages with concrete file targets, contract changes, tests, risks, and acceptance criteria. Ordered by autonomy payoff per unit of risk. |

## Executive summary of the plan

1. **Durable goal ledger (P1).** Autoprompt's single biggest structural idea: store the exact mission once, append-only, with hashes and a resume frontier — outside the working tree. Haze's goal state currently lives in conversation + in-memory checkpoints; a crash or session restart loses the frontier. Port the `PROMPTS.txt`/`GATELOG.md` discipline into haze's existing session JSONL as a first-class goal record.
2. **Ask re-derivation at completion (P2).** Autoprompt's goal-checker re-derives *every* user ask from the exact mission text and refuses DONE on any unmet ask. Haze's completion readiness counts tasks and validation events but never re-reads what the user actually asked for. Add model-derived acceptance asks to `WorkState` and make completion readiness consume them.
3. **Independent verification slice (P3).** Autoprompt's load-bearing rule: no agent verifies work it authored; a blind fresh verifier judges the deliverable against the mission. Haze has subagents but they are never wired into the completion decision. Add a fresh-context `verify` worker whose structured verdict becomes completion evidence for implement/fix goals.
4. **Debug depth lock (P4).** Autoprompt's `G3.5`: prove the bug RED from the issue text before touching code, name the deepest-cause function, require competing hypotheses, and bind completion to a red→green pair. Haze tracks validation sequence numbers but not red-before-green for fix intents. Make the fix-intent completion gate require the pair.
5. **Proportional goal shapes (P5).** Autoprompt scales ceremony by tier (T0–T3) and framework leaf. Haze runs one uniform loop. Adopt a light version: shape classification selects verification intensity, so trivial goals stay fast and ambitious goals get independent verify + sweep.
6. **Headless until-done supervisor (P6).** Autoprompt ships an OS-level relauncher that restarts the CLI after crashes until a DONE sentinel appears, with a frontier-progress poison guard. Haze headless runs have `--timeout` but no crash-resume. Build it on the P1 goal ledger.

Explicitly rejected: the 25-persona hierarchy, workspace-polluting governance files, per-role model routing, and a hard ≥95% coverage floor. Rationale in [`02-gap-analysis.md`](02-gap-analysis.md#rejected-adaptations).

## Reading order

Read `01` for the mechanics, `02` for the delta, `03` for execution. Each phase in `03` is independently shippable and ordered so earlier phases de-risk later ones.
