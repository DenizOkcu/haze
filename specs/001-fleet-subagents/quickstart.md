# Quickstart: /fleet — Parallel Subagent Orchestration

**Branch**: `001-fleet-subagents` | **Date**: 2026-07-09

`/fleet` analyzes a prompt and, when it splits into independent tasks, runs them in parallel as subagents.

## Prerequisites

- haze installed (`npm i -g @denizokcu/haze`, Node >=22).
- A provider and model configured (`/provider`, `/model`). `/fleet` uses your current model; there is no default.
- The `subagent` tool is available (it is built-in).

## Install the skill

The skill ships as an example. Copy it into your skills directory:

```bash
# from a clone of this repo
mkdir -p ~/.haze/skills
cp -R examples/skills/fleet ~/.haze/skills/fleet
```

Or generate/install via the picker: type `/skills`, choose "add skill", and point it at the example (or describe "parallelize a prompt into concurrent subagents").

Verify it loaded:

```text
/skills        # "fleet" should appear and be enabled
```

## Use it

```text
/fleet research how library X handles retries, audit error handling in src/auth, and draft v2 migration notes
```

What happens:
1. The model states whether the prompt is parallelizable and lists the subtasks.
2. If parallelizable, it spawns one subagent per subtask (≤5 concurrent) and they run in parallel.
3. It returns a consolidated summary (per-subtask status + findings), which stays in the conversation for follow-ups.

If the prompt is **not** parallelizable (single or tightly-dependent task), `/fleet` tells you why and stops — re-submit it as a normal message to run it normally.

## Control

- **Abort**: press your abort key; all in-flight subagents stop and control returns.
- **Follow-up**: the aggregated result is in the conversation, so you can ask "summarize what fleet found" next.

## Tips

- Phrase independent tasks as a list for best decomposition.
- If two tasks edit the same file, `/fleet` will merge or sequence them rather than run them concurrently.

## Example: non-parallelizable

```text
/fleet refactor parseConfig and then update every caller step by step
```

Expected: `/fleet` reports this is sequential/dependent and does not fan out.

## Development

- Edit the skill: `examples/skills/fleet/SKILL.md` (Markdown only — no code).
- Validate: `npm test` (includes the example-skill smoke test under `tests/skills/`).
- Full gates: `npm run typecheck && npm test && npm run lint && npm run build`.
