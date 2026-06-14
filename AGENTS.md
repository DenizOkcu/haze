# AGENTS.md

Project-specific instructions for Haze (and other coding agents) working in this repository.

Last comprehensive analysis: 2026-06-13.

## Project overview

Haze is a pragmatic, intentionally limited agentic CLI for building apps from the terminal. It is a Node >=20, source-only TypeScript ESM package published as `@denizokcu/haze`.

Core product shape:

- Interactive terminal chat UI built with React + Ink.
- LLM integration through the Vercel AI SDK and OpenAI-compatible providers (`@ai-sdk/openai`).
- Transparent local tools for file discovery, reading, regex search, targeted edits, file creation, and bash execution.
- Lightweight autonomy features: session persistence, conversation compaction, goal/completion policy, validation-output parsing, subagents, Markdown skills, and task tracking.
- Minimal distribution model: source in `src/`, generated declarations/JS in `dist/`, thin published binary in `bin/haze.js`.

Current package version is `0.4.0`; always verify against `package.json` before release work.

## Common commands

```bash
# Install / bootstrap
npm install
npm ci                 # preferred in CI or clean checkouts

# Development
npm run dev            # run the CLI directly via tsx (interactive)
npm run haze           # alias for npm run dev
npm start              # run dist/cli/index.js after building

# Validation / quality gates
npm run typecheck      # tsc --noEmit (strict)
npm test               # vitest run
npm run test:watch     # vitest watch mode
npm run lint           # eslint src/
npm run lint:fix       # eslint src/ --fix
npm run context:report # estimated prompt/tool/context token breakdown

# Build / package
npm run clean          # remove dist/
npm run build          # clean + tsc, emits dist/ and .d.ts files
npm pack --dry-run     # inspect published tarball contents

# Release prep (manual only)
npm run typecheck && npm test && npm run lint && npm run build
npm pack --dry-run
git tag vX.Y.Z
git push origin main --tags
npm publish --access public
```

Notes:

- `prepublishOnly` runs `npm run typecheck && npm run build`; it does **not** run tests or lint, so run those manually for release/PR confidence.
- GitHub CI runs on Node 20 and 22 and currently executes `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`.
- ESLint only covers `src/`; tests are validated by TypeScript/Vitest but not linted by the configured script.

## Repository map

- `src/` — primary TypeScript/TSX source.
  - `cli/index.ts` — Commander entrypoint, CLI flags (`--debug`, `--continue`, `--no-session`), version loading, and dispatch to chat UI.
  - `cli/commands/chat.tsx` — main Ink/React interactive screen: provider/model flows, session lifecycle, context loading, slash command wiring, input history, live messages, status header, queued follow-ups, abort handling.
  - `cli/commands/commands.ts` — slash command parser and command handlers: help, settings, provider/model selection, init, sessions, compaction, skill aliases.
  - `cli/commands/streaming.ts` — core agent loop around `streamText`: tool orchestration, goal observation, continuation/retry policy, subagent/skill tool injection, tool display state, token estimates, idle timeout.
  - `cli/commands/formatters.ts` — compact display summaries for tool calls/results, bash output details, elapsed-time formatting.
  - `cli/commands/skills.tsx` — skill-related UI helpers.
  - `config/` — runtime config and user data paths.
    - `paths.ts` defines `~/.haze` and global skills directory.
    - `settings.ts` reads/writes `~/.haze/settings.json` and preserves legacy OpenRouter settings.
    - `providers.ts` resolves active provider/model, provider defaults, model selectors, saved keys.
    - `contextFiles.ts` loads `~/.haze/AGENTS.md`, `~/.haze/CLAUDE.md`, then ancestor `AGENTS.md`/`CLAUDE.md` files from filesystem root to cwd; each file is capped at 20k chars and has size/hash diagnostics.
    - `inputHistory.ts` persists input history under `~/.haze/history`.
  - `llm/` — model client, prompts, and tool definitions.
    - `client.ts` builds an OpenAI-compatible chat model from env vars or settings.
    - `systemPrompt.ts` and `initPrompt.ts` define agent behavior and `/init` guidance.
    - `hazeTools.ts` defines built-in tools: `listFiles`, `readFile`, `grep`, `editFile`, `replaceLines`, `writeFile`, `bash`, `readToolOutput`, `writeTasks`.
    - `toolResultTypes.ts` contains structured tool/validation result types and guards.
  - `core/agent/` — context accounting, request assembly, bounded tool-output storage, structured work state, model-message compaction, agent events, and retry/context-overflow helpers.
  - `core/goal/` — request intent classification, session-goal phase tracking, and completion/continuation decisions.
  - `core/safety/bashClassifier.ts` — bash risk/trait classifier; classification is metadata, not a confirmation gate.
  - `core/validation/outputParser.ts` — parses common test/typecheck/lint/build output into compact validation summaries.
  - `core/session/sessionStore.ts` — durable JSONL session files under `~/.haze/sessions`, per-workspace hashed directory, snapshot restore.
  - `core/tasks/taskStorage.ts` — workspace-local task list persisted to `.haze/tasks.json`.
  - `core/subagent/subagentRunner.ts` — `subagent` tool for independent parallel investigation/action with capped tool loops.
  - `skills/` — Markdown skill system.
    - `SkillLoader.ts` parses `SKILL.md` YAML frontmatter, validates names/descriptions, and loads relative referenced files (max 50k bytes each, no escaping skill dir).
    - `SkillRegistry.ts` loads global skills from `~/.haze/skills`.
    - `skillTools.ts` exposes one `skill` catalog tool; it returns instructions first and one referenced file only on demand.
    - `builder/SkillBuilder.ts` creates skills from natural-language descriptions, using a model when configured and a deterministic fallback otherwise.
    - `types.ts` defines loaded skill and registry types.
  - `ui/` — reusable Ink components (`Header`, `TextInput`, `MarkdownText`, `ErrorView`) and `theme.ts`.
  - `utils/` — workspace-safe path helpers, directory walking, filesystem and YAML utilities.
- `tests/` — Vitest suite covering CLI commands/formatters, config, core agent/goal/safety/session/validation logic, haze tools, skills, and utils.
- `examples/skills/` — packaged reference skill example(s), including `SKILL.md` plus optional referenced files.
- `bin/haze.js` — npm binary shim; keep it thin.
- `dist/` — generated build output; never edit directly.
- `docs/index.html` — generated/static documentation page included in the repo.
- `.github/workflows/ci.yml` — GitHub Actions CI (Node 20 + 22: `npm ci`, typecheck, test, build).
- `calc-app/`, `haiku/` — non-project sample/fixture directories; not part of the published package.
- Root metadata: `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, README, CHANGELOG, CONTRIBUTING, LICENSE.

## Runtime behavior and important contracts

### Providers and model selection

- Default provider constants currently live in `src/config/providers.ts` (`openrouter`, OpenRouter base URL, default model).
- Runtime model config is resolved in this order:
  - `OPENAI_BASE_URL` overrides provider URL.
  - `OPENAI_API_KEY` overrides saved provider key / legacy key.
  - `HAZE_MODEL` overrides saved/default model.
  - Otherwise use `~/.haze/settings.json` provider/model settings.
- Local OpenAI-compatible providers may intentionally use a placeholder API key (`not-needed`).

### Agent tools

Built-in tools in `src/llm/hazeTools.ts` are intentionally small and structured:

- `listFiles` — workspace-confined listing, recursive option, cursor pagination, `.gitignore` aware.
- `readFile` — bounded UTF-8 read with optional 1-based offset/limit; returns one numbered `content` field plus pagination metadata.
- `grep` — ripgrep-backed structured regex search with optional path/glob/context/case and a global match cap.
- `editFile` — unique text replacements; tolerates readFile line-number prefixes and trailing-whitespace-only differences only when still unique; multiple replacements for one file should be in one call.
- `replaceLines` — 1-based inclusive line range replacement; useful when exact text is ambiguous or stale.
- `writeFile` — creates files and parents; refuses to overwrite existing files unless `overwriteExisting=true`.
- `bash` — runs `bash -lc` in the workspace with timeout, classification metadata, compact validation summaries, and retrievable handles for oversized output.
- `readToolOutput` — retrieves an omitted output page by process-scoped handle; handles are cleared for new sessions.
- `writeTasks` — full-replacement task list for tracking multi-step work. Model passes the complete list every call; IDs and timestamps are generated server-side. Persists to `.haze/tasks.json` in the workspace.

Tool constraints:

- File tools are restricted to `process.cwd()` via `resolveWorkspacePath`.
- File tools respect `.gitignore` by default; use `allowIgnored`/`includeIgnored` only when explicitly needed.
- `node_modules` and `.git` are skipped by directory walking.
- Direct file output is capped at 50k chars; command output is compacted near 12k chars and remains retrievable by handle.
- Repeated read-only calls are deduplicated when no mutation occurred; after failed mutations, the model is forced toward a fresh read before retrying.

### Task tracking

- Tasks are stored in `.haze/tasks.json` in the workspace (workspace-local, gitignored with the rest of `.haze/`).
- The `writeTasks` tool uses full-replacement semantics: every call sends the complete list, replacing whatever existed before.
- Server-side ID generation prevents ID collisions and hallucinated IDs.
- Tasks are managed by the LLM via the `writeTasks` tool; there is no user-facing slash command.
- `/clear` also clears tasks.
- Types and storage live in `src/core/tasks/taskStorage.ts`; the tool is in `src/llm/hazeTools.ts`.

### Sessions, context, and compaction

- Durable sessions are JSONL files under `~/.haze/sessions/<cwd-hash>/<session-id>.jsonl`.
- Sessions store headers, UI messages, conversation snapshots, structured work-state snapshots, and events.
- `haze --continue` and `/resume` restore the latest conversation and work-state snapshots for the workspace.
- `/compact [instructions]` uses token-aware compaction and embeds exact structured work state with the recent message window.
- Runtime control nudges use `<haze_control>` messages for one request only and must not be persisted as user conversation.
- Older successful tool results may be reduced to protocol-safe summaries; recent results and failures remain verbatim.
- Context files are loaded at startup and on refresh; root `AGENTS.md` is injected into the system prompt, so keep this file accurate and concise enough to fit context.

### Skills

- Skills are Markdown directories in `~/.haze/skills/<name>/SKILL.md` with required YAML frontmatter:
  - `name` — letters, numbers, hyphens, underscores only.
  - `description` — non-empty, ideally starts with “Use when ...”.
- Skill bodies are instructions only; they do not execute code by themselves.
- Relative references in a skill body are loaded if they are Markdown links or plain file-looking paths; references must remain inside the skill directory and be <=50k bytes.
- Slash commands include `/create-skill`, `/skills`, `/skill-info`, `/validate-skill`, `/remove-skill <name> --yes`.
- The model-facing `skill` tool takes an exact skill name. It returns the body and reference paths first; a later call can load one reference.

### Subagents

- `streaming.ts` adds a `subagent` tool alongside built-in tools and skills.
- Use subagents only when work splits into genuinely independent parallel investigations or actions.
- Do not use subagents for simple sequential tasks where the main agent already has sufficient context.

## Coding conventions

- Strict TypeScript with `module`/`moduleResolution` set to `NodeNext`, target ES2022, JSX `react-jsx`, declarations enabled.
- ESM everywhere (`type: "module"`); TypeScript imports of local modules should use `.js` extensions.
- Prefer plain TypeScript for core logic; React/Ink should stay in CLI/UI layers.
- Use Zod for AI SDK tool schemas and generated-object schemas.
- YAML parsing/writing uses the `yaml` package.
- Keep functions small and testable; core logic should usually live under `core/`, `config/`, `skills/`, `llm/`, or `utils/`, not embedded in UI components.
- Preserve existing style: no Prettier config, compact object literals where already used, no unnecessary formatting churn.
- ESLint rules: `no-unused-vars` is an error (args prefixed `_` ignored), explicit return types are off, `no-explicit-any` is a warning.
- Avoid `any`; use `unknown`, type guards, narrow interfaces, or existing tool result types where practical.
- For CLI display changes, update formatter tests and any relevant chat/streaming behavior tests.
- For tool behavior changes, update the matching `tests/hazeTools/*.test.ts` and result-display formatting when needed.
- For validation parsing changes, update `tests/core/validationParser.test.ts`.
- For skill behavior changes, update `tests/skills/*` and example skills if the public contract changes.

## Editing guidelines for agents

- First check `git status --short` before large work; this repo may contain user edits. Do not overwrite unrelated uncommitted changes.
- Never edit `dist/`, `node_modules/`, `.git/`, generated outputs, or ignored runtime state.
- Do not edit `package-lock.json` unless dependency changes require regenerating it.
- Prefer targeted source edits over whole-file rewrites. If using exact replacements, keep `oldText` unique and minimal; merge nearby or same-file changes into one edit operation where the tool requires it.
- If an exact edit fails, re-read the current file before retrying.
- Prefer file tools for source edits. Use bash for inspection, tests, builds, git status/diff, and commands the user explicitly requested.
- Do not use bash redirection/sed/perl/tee to edit source unless there is a strong reason or explicit user request.
- Do not commit, tag, publish, delete, reset, force-push, or run destructive cleanups unless explicitly requested.
- Keep changes minimal and focused on the user request.

## Testing expectations

Run validation appropriate to the change:

- General source changes: `npm run typecheck`, `npm test`, `npm run lint`.
- Build/package changes: also `npm run build` and `npm pack --dry-run`.
- CLI/TUI-only visual changes: typecheck + relevant tests; manual smoke with `npm run dev` when practical.
- Tool behavior changes: run the specific haze tool tests plus full `npm test` when practical.
- Skill changes: validate via tests and, for manually created skills, `/validate-skill <dir-or-name>` inside Haze when practical.

If validation is skipped, state clearly why in the final response.

## Packaging and release notes

- Published package files are controlled by `package.json` `files`: `bin`, `dist`, `README.md`, `LICENSE`, `CHANGELOG.md`, `examples`.
- Build output is pure `tsc` to `dist/` with declaration files.
- `bin/haze.js` is the executable npm shim and should continue pointing at `dist/cli/index.js`.
- Before publishing, inspect `npm pack --dry-run` output to ensure no source-only or local runtime files accidentally ship beyond the intended set.
- Publishing is manual and requires explicit user instruction.

## Safety and secrets

- Never check in secrets, `.env*`, provider API keys, local settings, or runtime memory/session files.
- `~/.haze/settings.json` may contain provider keys; do not read or print it unless the user explicitly asks and understands the sensitivity.
- This repo’s local `.haze/` runtime data is ignored for a reason; avoid inspecting ignored runtime files unless explicitly requested.
- Haze intentionally has no confirmation gates around bash; commands are classified and displayed, but agents should still avoid irrelevant destructive actions.

## Useful references while working

- README sections: “Agent tools”, “Subagents”, “Context files”, “Safety model”, “Local development”, “Release”.
- `src/llm/systemPrompt.ts` for the model-facing operating contract.
- `src/llm/initPrompt.ts` for how `/init` should analyze and update this file.
- `tests/` for expected behavior; many modules expose small internals specifically to make tests practical.

Update this file whenever project conventions, scripts, architecture, tool contracts, or release process materially change.
