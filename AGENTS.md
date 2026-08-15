# AGENTS.md

Last updated: 2026-08-16 for the 0.11.0 release.

Project instructions for haze coding agents. Keep this root file concise; read nested `AGENTS.md` files in the subtree you touch for precise contracts.

Last analysis: 2026-08-15.

## Project overview

haze is a Node >=22 TypeScript ESM CLI package (`@denizokcu/haze`) for terminal-based agentic app building.

Core shape:

- React + Ink interactive terminal chat UI.
- Vercel AI SDK with OpenAI-compatible providers.
- Local tools for file discovery/read/search/edit/write, public URL fetch, foreground and managed background processes, LSP/MCP integration, global/project skills, image attachments, subagents/fleet, task tracking, session browsing/forking, and compaction.
- Source lives in `src/`; generated `dist/` must not be edited.

Verify current package version in `package.json` before release work.

## Common commands

```bash
npm install
npm ci                 # preferred in CI or clean checkouts
npm run dev            # run CLI via tsx
npm run haze           # alias for dev
npm start              # run built dist CLI

npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run lint           # eslint src/
npm run context:report # estimated prompt/tool/context token breakdown

npm run build          # clean + tsc
npm pack --dry-run     # inspect published tarball
```

Before release/PR confidence: `npm run typecheck && npm test && npm run lint && npm run build`.

## Repository map

- `src/` — TypeScript/TSX source. See nested `src/**/AGENTS.md` files.
- `tests/` — Vitest suite. See `tests/AGENTS.md`.
- `bin/haze.js` — thin npm binary shim to built CLI.
- `dist/` — generated build output; never edit directly.
- `examples/skills/` — packaged skill examples.
- `docs/index.html` — static/generated docs page in repo.
- `calc-app/`, `haiku/` — sample/fixture directories.

## Global coding conventions

- Strict TypeScript, ESM (`type: "module"`), NodeNext module resolution, ES2022 target.
- Local TypeScript imports use `.js` extensions.
- Prefer plain TypeScript for core logic; keep React/Ink in CLI/UI layers.
- Use Zod for AI SDK tool schemas and generated-object schemas.
- YAML parsing/writing uses the `yaml` package.
- Avoid `any`; prefer `unknown`, type guards, or existing result types.
- Preserve local formatting style; avoid broad formatting churn.
- ESLint: unused vars are errors unless args start with `_`; `no-explicit-any` is an error.

## Editing rules

- Check `git status --short` before large work; do not overwrite unrelated user edits.
- Never edit `dist/`, `node_modules/`, `.git/`, generated outputs, secrets, or ignored runtime state.
- Do not edit `package-lock.json` unless dependency changes require it.
- Prefer targeted edits over whole-file rewrites for source.
- Do not commit, tag, publish, reset, delete, force-push, or run destructive cleanups unless explicitly requested.

## Runtime contracts to preserve

Recent decisions to preserve:

- Runtime support floor is Node >=22. Keep docs, package metadata, and generated docs aligned.
- Provider/model selection is explicit: do not silently fall back to the first configured provider/model.
- Settings parsing should fail loudly for malformed files and preserve unrelated/unknown fields when patching.

- No default provider/model. Users configure providers via `/provider`; no user-facing env vars for provider/model settings.
- File tools are confined to `process.cwd()`, respect `.gitignore` by default, and skip `.git`/`node_modules` walking; user-typed `@path` mentions and bare paths containing `/` are the exception and may bless host paths outside it for read-only tools (readFile, grep, listFiles). Mutating tools never honour the bless set. URL safety fails closed for malformed IPv6-shaped literals.
- Output is aggressively bounded/reduced but raw large outputs may be retrievable by handle. Exact line paging uses bounded, signature-validated sparse indexes; subprocess teardown must not hang when escaped descendants retain stdio pipes.
- Failed file mutations activate read-only recovery only when their structured result explicitly requests `readFile`. Recovery state advances in the AI SDK's ordered `onStepEnd` callback, compares lexical workspace path identity (`a.ts` and `./a.ts` are equivalent), and repeated-tool suppression applies only to the immediately following step.
- Abort causes are distinguished (user / turn deadline / model-stream idle stall). An idle stall with no emitted step output retries via the shared bounded model-retry pool, salvaging the conversation to the last completed step; an exhausted stall pauses the turn (status `failed`) preserving the active goal and exposing a one-key R resume interactively. An attempt that ignores cancellation past a grace window is forcibly settled at turn level: owned resources close exactly once (bounded), the attempt's callbacks are permanently quarantined so late output cannot mutate the finished turn, and the turn resolves `aborted` with a truthful teardown report.
- Completion is evidence-gated, not text-gated: a voluntary final is rejected while this turn's `writeTasks` list has pending/in-progress items or post-mutation validation is missing/stale/failed (implement/fix/test intents). Rejected finals trigger autonomous goal continuation inside the same logical turn and budgets; a logical-goal supervisor (`runAgentGoal`) spans physical turns, so a step/tool budget boundary (including `tool-calls` finishes) automatically starts a fresh continuation turn against the preserved conversation while measurable progress continues and the goal deadline remains. It stops only for structured completion, hard blockers, user cancellation, the goal deadline, or two consecutive no-progress cycles — never reporting incomplete work as `complete`. Old workspace task files never block unrelated turns; carried evidence hydrates continuation turns via seq baselines so validation debt survives the boundary.
- Session state is JSONL under `~/.haze/sessions`; new sessions stay memory-only until the first resumable message, empty legacy files stay out of resume/latest listings, persisted sessions skip streaming `message_update` spam and slim large tool outputs, and file LLM logging under `~/.haze/logs` is enabled only by `--debug`.
- The Ink transcript is append-only static output above a dynamic tail. Streamed assistant Markdown may move into static output only after a root block is stable; the final root remains plain and dynamic until another root begins or the response finishes. The dynamic tail (streaming roots, live tool groups, task bar) is clamped to a viewport-derived row budget so Ink never enters its scrollback-wiping overflow path; row estimates mirror Ink's own `wrap-ansi` wrapping.
- Context files: global `~/.haze/AGENTS.md` wins over `~/.claude/CLAUDE.md`; ancestor `CLAUDE.md`/`AGENTS.md` load at startup; nested subtree files load lazily when tools touch that subtree and are reread when their signature changes.
- Skills are Markdown instruction packages under global `~/.haze/skills/<name>/SKILL.md` or project `<workspace>/.haze/skills/<name>/SKILL.md`; they do not execute code. Project skills are untrusted repo content, real-path-confined to the workspace, visibly labeled, and take precedence over same-named global skills unless the project scope is disabled.

## Testing expectations

Run validation appropriate to the change:

- General source: `npm run typecheck`, `npm test`, `npm run lint`.
- Build/package: also `npm run build` and `npm pack --dry-run`.
- Tool behavior: targeted `tests/hazeTools/*` plus relevant formatter tests.
- Validation parser: `tests/core/validationParser.test.ts`.
- Skills: `tests/skills/*` and example skills if public contract changes.

If validation is skipped, state why in the final response.

## Spec-Kit

This repository uses the [spec-kit](https://github.com/github/spec-kit) workflow for AI-assisted feature development.
Spec-kit is a convention for structuring feature specs, plans, and tasks in a `.specify/` directory so that AI agents can read and act on them.
This project uses an opinionated local tooling layer to generate the artifacts that live there — the source of truth for the workflow itself is the spec-kit repo linked above.

### `.specify/` directory

| Path | Purpose |
|------|---------|
| `.specify/templates/` | Markdown templates for specs, plans, tasks, and checklists |
| `.specify/memory/` | Long-lived context files (e.g. `constitution.md`) read by agents |
| `.specify/scripts/` | Helper shell scripts for common workflow steps |
| `.specify/hooks.yml` | CI/automation hook definitions |

### How to use it

- Start a new feature: `/speckit-specify` — creates a spec from a template and opens a clarification loop.
- Generate a plan: `/speckit-plan` — converts an approved spec into a structured plan.
- Break into tasks: `/speckit-tasks` — decomposes a plan into trackable tasks.
- Implement: `/speckit-implement` — works through tasks and updates checklists.
