# AGENTS.md

Project instructions for Haze coding agents. Keep this root file concise; read nested `AGENTS.md` files in the subtree you touch for precise contracts.

Last analysis: 2026-06-29.

## Project overview

Haze is a Node >=20 TypeScript ESM CLI package (`@denizokcu/haze`) for terminal-based agentic app building.

Core shape:

- React + Ink interactive terminal chat UI.
- Vercel AI SDK with OpenAI-compatible providers.
- Local tools for file discovery/read/search/edit/write, public URL fetch, bash execution, LSP/MCP integration, skills, subagents, task tracking, sessions, and compaction.
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
- ESLint: unused vars are errors unless args start with `_`; `no-explicit-any` is a warning.

## Editing rules

- Check `git status --short` before large work; do not overwrite unrelated user edits.
- Never edit `dist/`, `node_modules/`, `.git/`, generated outputs, secrets, or ignored runtime state.
- Do not edit `package-lock.json` unless dependency changes require it.
- Prefer targeted edits over whole-file rewrites for source.
- Do not commit, tag, publish, reset, delete, force-push, or run destructive cleanups unless explicitly requested.

## Runtime contracts to preserve

- No default provider/model. Users configure providers via `/provider`; no user-facing env vars for provider/model settings.
- File tools are confined to `process.cwd()`, respect `.gitignore` by default, and skip `.git`/`node_modules` walking.
- Output is aggressively bounded/reduced but raw large outputs may be retrievable by handle.
- Session state is JSONL under `~/.haze/sessions`; persisted sessions skip streaming `message_update` spam and slim large tool outputs, while file LLM logging under `~/.haze/logs` is enabled only by `--debug`.
- Context files: global `~/.haze/AGENTS.md` wins over `~/.claude/CLAUDE.md`; ancestor `CLAUDE.md`/`AGENTS.md` load at startup; nested subtree files load lazily when tools touch that subtree and are reread when their signature changes.
- Skills are Markdown instruction packages under `~/.haze/skills/<name>/SKILL.md`; they do not execute code.

## Testing expectations

Run validation appropriate to the change:

- General source: `npm run typecheck`, `npm test`, `npm run lint`.
- Build/package: also `npm run build` and `npm pack --dry-run`.
- Tool behavior: targeted `tests/hazeTools/*` plus relevant formatter tests.
- Validation parser: `tests/core/validationParser.test.ts`.
- Skills: `tests/skills/*` and example skills if public contract changes.

If validation is skipped, state why in the final response.
