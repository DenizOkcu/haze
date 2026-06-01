# Haze

Haze is a pragmatic agentic CLI for building apps from the terminal. It uses the Vercel AI SDK, OpenAI-compatible providers such as OpenRouter, and transparent local tools for reading, editing, writing, and testing files.

## Install

```bash
npm install -g @denizokcu/haze
```

Then start Haze:

```bash
haze
```

For local development from this repository:

```bash
npm install
npm run dev
```

## First-time setup

Inside Haze, configure OpenRouter:

```txt
/login
/model openai/gpt-4o-mini
```

`/login` stores settings in `~/.haze/settings.json`:

```json
{
  "provider": "openrouter",
  "apiKey": "...",
  "baseURL": "https://openrouter.ai/api/v1",
  "model": "openai/gpt-4o-mini"
}
```

Environment variables override saved settings:

```bash
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
export HAZE_MODEL=openai/gpt-4o-mini
```

## Usage

```bash
haze
haze --debug
```

Chat commands:

```txt
/help
/login
/model <name>
/model
/settings
/skill help
/skill create <description>
/skill list
/skill info <name>
/skill validate <name-or-dir>
/skill remove <name> --yes
/init
/clear
/exit
```

`/init` explores the current workspace using `.gitignore`-aware tools and creates or updates an `AGENTS.md` file with project instructions for future Haze sessions.

Input conveniences:

- `↑` / `↓` browse persisted input history.
- `←` / `→` move the cursor.
- `Esc` clears the input field while typing.
- `Esc` aborts the active model/tool turn while Haze is thinking, then re-enables input.
- `Ctrl+A` / `Ctrl+E` jump to start/end.

Input history is stored in `~/.haze/history/input-history.json`.

## Agent tools

Haze exposes a small toolset to the model:

- `listFiles` — structured project discovery.
- `readFile` — read UTF-8 files with optional line ranges.
- `editFile` — exact unique text replacements.
- `replaceLines` — replace a 1-based line range when exact edits are ambiguous.
- `writeFile` — create or overwrite files.
- `bash` — run shell commands for tests, builds, and inspection.
- `skill_*` — Markdown skills from `~/.haze/skills`, exposed only by name and description until the model chooses one.

Tool calls are shown inline in the chat transcript so you can see what Haze is doing.

## Context files

Haze loads project instructions from context files and includes them in the system prompt:

- `~/.haze/AGENTS.md`
- `~/.haze/CLAUDE.md`
- `AGENTS.md` files found while walking from the filesystem root to the current workspace
- `CLAUDE.md` files found while walking from the filesystem root to the current workspace

Use `AGENTS.md` for shared project instructions. `CLAUDE.md` is supported for compatibility with existing projects.

## Safety model

- File tools are restricted to the current workspace.
- File tools follow `.gitignore` by default.
- Ignored files can still be accessed when explicitly needed by using the tool's ignored-file override.
- Haze is prompted to ask before destructive actions.
- Bash is powerful; review commands shown in the transcript, especially in early releases.

## Skills

Skills live in `~/.haze/skills/`. A skill is a directory containing a Markdown `SKILL.md` file. Metadata lives in frontmatter and behavior lives in Markdown instructions. `/skill create <description>` uses Haze's skill-creator prompt with the configured model to generate the new skill files:

```md
---
name: commit-changes
description: Use when the user asks to commit, save, checkpoint, or prepare a git commit.
---

Review uncommitted changes, decide what belongs in the commit, and create a concise commit message.

References:
- examples/good-commit-message.md
```

Additional files may live beside `SKILL.md`, but Haze only loads files explicitly referenced from `SKILL.md`. Skills do not execute code; each installed skill is exposed to the model as a `skill_*` tool that returns its instructions and referenced files.

Skill commands run inside the interactive Haze session, not as top-level shell subcommands:

```txt
/skill create <description>
/skill list
/skill info <name>
/skill validate <name-or-dir>
/skill remove <name> --yes
```

`/skills ...` remains as a compatibility alias for `/skill ...`. `/skill remove` requires `--yes` because it deletes files.

## Development

```bash
npm install
npm run typecheck
npm test
npm run lint
npm run build
npm pack --dry-run
```

The npm package intentionally ships only `bin`, `dist`, `README.md`, `LICENSE`, `CHANGELOG.md`, and `examples`.

## Release

```bash
npm run typecheck
npm run build
npm pack --dry-run
git tag v0.0.1
git push origin main --tags
npm publish --access public
```

## License

MIT
