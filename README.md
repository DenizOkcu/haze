# Haze

A minimal LLM harness for your terminal.

## What's new in 0.3.0

Haze 0.3.0 polishes the experience around sessions and the docs site.

- The docs site has been redesigned with a cleaner layout, improved typography, better mobile responsiveness, scroll-reveal animations, and accessibility improvements.
- The task bar now appears above the activity spinner so in-progress and pending tasks are always visible during active agent turns.
- Tasks are automatically cleared when starting or exiting a session, preventing stale task state from leaking across conversations.

Previous releases:

- **0.2.0** — Reliability release: stronger continuation after failed edits and validation, structured bash classification, parsed validation summaries, multi-line chat input with vertical cursor movement.
- **0.1.0** — Bundled ripgrep, subagent delegation, inline diff display.
- **0.0.3** — Durable sessions, context compaction, provider management.
- **0.0.2** — Markdown skills, autocomplete, listFiles pagination.
- **0.0.1** — Initial release.

Haze works with OpenAI-compatible providers, including OpenRouter and local endpoints. Use `/provider` to choose or add one, then `/model` to select a model.

```txt
  _
 | |
 | |__   __ _ _______
 | '_ \ / _` |_  / _ \
 | | | | (_| |/ /  __/
 |_| |_|\__,_/___\___|
```

Haze keeps guardrails light. The LLM can work from the terminal with freedoms close to yours, while trying to stay scoped to the current project. It is aimed at developers who want an expert-oriented tool, not a permission dialog factory. Watch the tool calls. Keep your hands near the wheel. Progress.

## Getting started

Install Haze:

```bash
npm install -g @denizokcu/haze
```

Open Haze from your project:

```bash
$ haze
```

On first run, create or choose a provider, then choose your first model:

```txt
/provider
/model
```

`/provider` opens provider setup for any OpenAI-compatible endpoint — e.g. OpenRouter, OpenAI, LM Studio, Ollama, or a proxy. Haze will ask for a provider name, base URL, optional API key, and model names.

`/model` selects the model Haze should use. You can also set one directly:

```txt
/model anthropic/claude-sonnet-4.6
/model local:llama3.1
```

Or use environment variables for any OpenAI-compatible endpoint:

```bash
# e.g. OpenRouter, OpenAI, LM Studio, Ollama, or an OpenAI-compatible proxy
export OPENAI_API_KEY=... # provider API key, if needed; local providers may not need one
export OPENAI_BASE_URL=https://openrouter.ai/api/v1 # or http://localhost:1234/v1, http://localhost:11434/v1, ...
export HAZE_MODEL=anthropic/claude-sonnet-4.6 # or gpt-4.1, llama3.1, qwen2.5-coder, ...
```

Saved settings live in `~/.haze/settings.json`. Providers can include API keys, base URLs, and model lists; local OpenAI-compatible providers can be configured without a key.

Haze is intentionally minimal: chat, local tools, context files, sessions, and Markdown skills. Any workflow beyond the core is meant to be grown with the LLM through `/create-skill <description>`. If you want reviews, release prep, deploy checks, debugging rituals, or your team's strange checklist, ask Haze to create a skill and then refine the Markdown.

## Get productive immediately

Open a project and ask for work:

```txt
create a calculator in calc-app in ruby with add subtract multiply divide
```

Haze will inspect, search, write files, run commands, and show compact tool activity inline. Small file edits include a colorized line diff with one context line before and after the change; large diffs stay summarized so the transcript does not become a wall of noise. Bash validation output is summarized when possible so failures point at the relevant files, tests, or diagnostics. Sessions are saved by default so you can resume the latest workspace conversation with `haze --continue` or `/resume`.

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

Skills are Markdown workflows that Haze creates with `/create-skill` and stores in `~/.haze/skills` so you can inspect or refine them later.

If you do something for the second time, build a skill for it:

```txt
/create-skill review the diff between my current branch and main, focusing on bugs, tests, DRY and KISS
```

Haze uses the model to create the skill file for you:

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
/provider
/model
/model <name-or-provider:name>
/model list
/settings
/init
/session
/resume
/new
/compact [instructions]
/clear
/exit

/create-skill <description>
/list-skills
/skill-info <name>
/validate-skill <name-or-dir>
/remove-skill <name> --yes
```

Legacy `/skill ...` and `/skills ...` commands still work as aliases.

CLI flags:

```bash
haze --debug       # show model/tool debug logs
haze --continue    # resume the latest saved session for this workspace
haze --no-session  # run without durable session storage
```

## Agent tools

Haze exposes a deliberately small toolset:

- `listFiles` — structured discovery, recursive with cursor pagination when needed.
- `readFile` — read UTF-8 files with optional line ranges.
- `grep` — ripgrep-backed regex search with path, glob, context-line, case, and result-limit controls.
- `editFile` — unique text replacements, with line-number-prefix tolerance for common model mistakes.
- `replaceLines` — line-range edits when exact replacements are awkward; slightly-too-large EOF ranges are clamped.
- `writeFile` — create files and parent directories.
- `bash` — run tests, builds, git commands, inspections, scripts, installs, and other shell workflows with command classification metadata.
- `skill_*` — load Markdown skill instructions on demand.

Tool calls are grouped in the transcript so you can see what happened without reading a novella. Successful targeted file edits show a compact diff with colored additions/removals and one context line around the change when the diff is small; larger diffs are summarized with a pointer to `git diff`. File-tool failures return structured reason codes and recovery hints instead of mystery stack traces. Bash validation commands can return parsed summaries with failed files, failed tests, diagnostics, and suggested next steps.

## Subagents

Subagents are a delegation feature, not another file operation. When a request clearly splits into independent parallel work, Haze can spin up focused agents with fresh context, let them inspect or act with their own capped tool loop, then fold their concise summaries back into the main conversation.

Use them for parallel investigation across separate areas of a codebase. Do not use them for single sequential tasks where the main agent already has the best context.

## Context files

Haze saves durable workspace sessions in `~/.haze/sessions`. Use `/session` to see the current file, `/new` to start fresh, `/resume` to restore the latest session, and `/compact` to summarize older model context while keeping recent messages.

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
- Bash commands are classified and shown with working-directory metadata, but Haze does not use command confirmation gates.
- Mutating and destructive commands can run when they are relevant to the user's request; this is intentional for expert users.
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

The npm package ships `bin`, `dist`, README, license, changelog, and examples.

## Release

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm pack --dry-run
git tag vX.Y.Z
git push origin main --tags
npm publish --access public
```

## License

MIT
