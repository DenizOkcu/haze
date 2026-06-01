# AGENTS.md

This file provides project-specific instructions for Haze (and other agents) working in the Haze repository.

## Project overview

Haze is a pragmatic, intentionally limited agentic CLI for building apps from the terminal (Node >=20). It uses the Vercel AI SDK with OpenAI-compatible providers (e.g. OpenRouter), React/Ink for an interactive TUI, and transparent local tools for file operations + bash.

- Published as `@denizokcu/haze` (ESM package).
- Core is a source-only ESM TypeScript project with a thin published `bin/` + `dist/`.
- Self-documents its own agent tools and context-file mechanisms (see README).
- Initial public release (v0.0.1).

## Common commands

```bash
# Install / bootstrap
npm install

# Development
npm run dev          # runs the CLI directly via tsx (interactive chat)
npm run haze         # alias for the above

# Validation & quality gates (run these frequently)
npm run typecheck    # tsc --noEmit (strict)
npm test             # vitest test suite
npm run lint         # eslint src/

# Build
npm run build        # clean + tsc (outputs to dist/)
npm run clean        # remove dist/
npm start            # node dist/cli/index.js (after build)

# Packaging / release prep
npm pack --dry-run

# Release (manual, see also prepublishOnly hook)
npm run typecheck && npm run build
npm pack --dry-run
git tag vX.Y.Z
git push origin main --tags
npm publish --access public
```

Typecheck, tests, and lint are the primary static gates. `prepublishOnly` enforces typecheck + build.

For local skills development, use in-app commands from an interactive Haze session: `/skills validate <dir>`, `/skills build <name> <toolName> <description...>`, etc.

## Architecture and important directories

- `src/` — primary source (TS/TSX)
  - `cli/` — Commander entrypoint (`index.ts`) and chat commands (`chat.tsx` is the main interactive TUI loop; `commands.ts` handles slash commands, including `/skills ...`).
  - `llm/` — AI client, Haze's tool definitions (`hazeTools.ts`), system/init prompts.
  - `tools/` — ToolExecutor and runner for agent tools.
  - `skills/` — manifest schema (zod), loader, registry, builder, and GitHub installer.
  - `config/` — paths, settings (JSON + env), persistent input history, context-file walker (loads AGENTS.md / CLAUDE.md walking up from cwd).
  - `ui/` — reusable Ink/React components (TextInput, MarkdownText, etc.) + theme.
  - `utils/` — small fs + yaml helpers.
- `bin/haze.js` — published CLI shim.
- `examples/skills/` — reference skill templates (copy of built-in examples; `skill.yaml` + tool .ts + optional prompts/).
- `dist/` — compiled output (generated; never commit or edit directly).
- `.haze/` — local skill overrides and runtime data (see .gitignore for `.haze/memory.json`).
- `haiku-app/` — example project created with Haze (treat as external; do not assume it reflects current source).
- Root: `package.json`, `tsconfig.json`, README, CHANGELOG, LICENSE.

File tools are always restricted to the current workspace and are `.gitignore`-aware by default (with opt-in for ignored files when explicitly required by the task).

## Coding conventions

- Strict TypeScript (see tsconfig: ES2022 + NodeNext ESM, JSX react-jsx, no implicit any, etc.).
- Use ESM throughout (`type: "module"` in package.json; `.js` extensions in imports for TS).
- Prefer exact-match `editFile` for code changes (one precise string replacement). Fall back to `replaceLines` only when the exact string is not unique.
- When editing, preserve user-provided content exactly. Reference conversation context rather than inventing new text.
- Keep changes minimal and focused; use file tools over raw bash where possible.
- React components (Ink) only for the chat UI; keep core logic in plain TS.
- Schemas → Zod (see `src/skills/manifestSchema.ts`).
- YAML for skill manifests.
- Add new agent tools via `src/llm/hazeTools.ts` + matching runner logic.
- Never check in secrets, `.env*`, or build artifacts.

## Tooling and package manager notes

- npm + `package-lock.json` only.
- Runtime TS via `tsx` (dev + skill execution).
- Build is pure `tsc --outDir dist`.
- ESLint is configured for `src/`; no Prettier is configured.
- Context files loaded at runtime: `AGENTS.md`, `CLAUDE.md` (and their `~/.haze/` global copies) are injected into the system prompt. Walking order starts at filesystem root.

## Testing / validation expectations

- Tests live under `tests/` and run with Vitest (`npm test`).
- Always run `npm run typecheck`, `npm test`, and `npm run lint` before commits, builds, or PRs when practical.
- Skill-related work must pass `/skills validate <dir>` inside Haze.
- Manual smoke-testing via `npm run dev` / `npm run haze` and the published `haze` binary after `npm run build`.
- For packaging: `npm pack --dry-run` + inspect tarball contents (only `bin/`, `dist/`, docs, and `examples/` ship).

## Safety notes and files/directories to avoid

- **Never** directly edit: `dist/`, `node_modules/`, `package-lock.json` (unless regenerating), build outputs, or generated files.
- File tools follow `.gitignore` by default — explicitly pass the ignored override **only** when you must touch an otherwise-ignored file and the user explicitly requests it.
- Destructive actions (rm -rf, git reset --hard, force-pushes, publishing, etc.) require explicit user confirmation first.
- Use `npm run clean` instead of manual `rm -rf dist`.
- Bash tool is powerful — always review the exact command shown in the transcript before execution. Prefer file tools (`listFiles`, `readFile`, `editFile`, etc.) for workspace changes.
- This repository's `.haze/memory.json` is gitignored for a reason (runtime state).
- When running Haze from inside this repo, be aware that local `.haze/skills/` and root `AGENTS.md` will be picked up.
- Review README sections on "Safety model", "Context files", and "Agent tools" for the model-facing contract.

Update this file when project conventions, scripts, or architecture materially change. It is loaded automatically for future Haze sessions in this workspace.
