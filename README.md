# Haze

A minimal LLM harness for your terminal.

Haze gives an AI model a small set of transparent local tools — read files, edit files, write files, list files, and run commands — then gets out of the way. Start with chat. Build your workflows as you work. Teach Haze with Markdown skills when a pattern repeats. Tiny spell, useful goblin.

MVP scope: Haze currently uses OpenRouter only. More providers are on the roadmap after the goblin learns to hold a spoon safely.

```txt
  _
 | |
 | |__   __ _ _______
 | '_ \ / _` |_  / _ \
 | | | | (_| |/ /  __/
 |_| |_|\__,_/___\___|
```

Haze keeps guardrails light. The LLM can work from the terminal with freedoms close to yours, while trying to stay scoped to the current project. Watch the tool calls. Keep your hands near the wheel. Progress.

## Install

```bash
npm install -g @denizokcu/haze
haze
```

First run inside Haze, do both steps:

```txt
/login
/model x-ai/grok-build-0.1
```

`/login` saves your API key. `/model` saves the model Haze should use. The recommended MVP model is `x-ai/grok-build-0.1`.

Or use environment variables:

```bash
export OPENAI_API_KEY=... # your OpenRouter API key
export HAZE_MODEL=x-ai/grok-build-0.1
```

Saved settings live in `~/.haze/settings.json`. The current MVP experience is documented around OpenRouter; more provider docs are future work.

## Get productive immediately

Open a project and ask for work:

```txt
create a calculator in calc-app in ruby with add subtract multiply divide
```

Haze will inspect, write files, run commands, and show compact tool activity inline.

Use `/` to discover commands and skills. `Tab` completes the top suggestion.

Useful starters:

```txt
/init
/create-skill review my current branch against main like a senior engineer
/create-skill prepare clean git commits from my uncommitted changes
/create-skill implement small features with tests and a concise summary
```

`/init` creates or updates `AGENTS.md` so future sessions understand the project.

## Skills: your workflows, grown while working

Skills are Markdown workflows stored in `~/.haze/skills`.

When you notice yourself asking for the same kind of work, make it a skill:

```txt
/create-skill review the diff between my current branch and main, focusing on bugs, tests, DRY and KISS
```

Haze uses the model to create:

```txt
~/.haze/skills/<skill-name>/SKILL.md
```

A skill is just Markdown with frontmatter, a role, a focused prompt, and a small output template:

```md
---
name: code-review-diff-main
description: Use when the user asks for a code review of the current branch against main.
---

# Role

You are a focused code reviewer.

# Focused prompt

Review the actual change and return useful, evidence-based feedback.

# Procedure

Inspect branch state, changed files, staged and unstaged diffs, then review incrementally.

# Output template

## Summary
- <scope and result>

## Findings
- <prioritized findings, or "No issues found">

## Evidence inspected
- <commands/files used>
```

Installed skills appear as slash commands like:

```txt
/code-review-diff-main
```

They are also exposed to the model as `skill_*` tools. The skill does not execute code; it gives Haze a workflow to follow.

This is the trick: do normal work, notice friction, create a skill, keep going. Your workflow adapts instead of asking you to adapt to the tool. Rude, but in a good way.

## Commands

```txt
/help
/login
/model <name>
/model
/settings
/init
/clear
/exit

/create-skill <description>
/list-skills
/skill-info <name>
/validate-skill <name-or-dir>
/remove-skill <name> --yes
```

Legacy `/skill ...` and `/skills ...` commands still work as aliases.

## Agent tools

Haze exposes a deliberately small toolset:

- `listFiles` — structured discovery, recursive with cursor pagination when needed.
- `readFile` — read UTF-8 files with optional line ranges.
- `editFile` — exact unique text replacements.
- `replaceLines` — line-range edits when exact replacements are awkward.
- `writeFile` — create files and parent directories.
- `bash` — run tests, builds, git commands, and inspections.
- `skill_*` — load Markdown skill instructions on demand.

Tool calls are grouped in the transcript so you can see what happened without reading a novella.

## Context files

Haze loads project instructions from:

- `~/.haze/AGENTS.md`
- `~/.haze/CLAUDE.md`
- `AGENTS.md` files from filesystem root to the current workspace
- `CLAUDE.md` files from filesystem root to the current workspace

Use `AGENTS.md` for project conventions, commands, architecture notes, and things future-you does not want to re-explain.

## Safety model

- File tools are restricted to the current workspace.
- File tools follow `.gitignore` by default.
- Ignored files require an explicit override.
- Bash mutations are discouraged by the tool contract.
- Destructive actions should require explicit user confirmation.
- Haze is powerful enough to help and dumb enough to deserve supervision. Ideal software, basically.

## Local development

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run lint
npm run build
```

Package check:

```bash
npm pack --dry-run
```

The npm package ships `bin`, `dist`, docs, license, changelog, and examples.

## Release

```bash
npm run typecheck
npm run build
npm pack --dry-run
git tag vX.Y.Z
git push origin main --tags
npm publish --access public
```

## License

MIT
