# Haze

A minimal LLM harness for your terminal.

## What's new in 0.6.0

Haze 0.6.0 adds an AI SDK-native ToolLoopAgent core, optional LSP semantic navigation, and a cleaner segmented transcript for tool/text turns.

- **Fetch public URLs.** The new `fetch` tool reads public HTTP(S) pages as Markdown, JSON, or text, with SSRF protections, redirects re-checked, bounded downloads, and oversize output retrievable via `readToolOutput`.
- **No provider env vars.** `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `HAZE_MODEL`, and `HAZE_CONTEXT_BUDGET_SHARE` are no longer read. Configure providers, models, keys, and base URLs through `/provider`, `/model`, `/settings`, and `~/.haze/settings.json`.
- **Debug-only LLM logs.** Detailed JSONL LLM logging is now off by default and only starts with `haze --debug`. `/logs` can still review historical logs.
- **Quieter tool output.** Bash, git, search, JSON, diff, and log output are reduced before they enter model context, with raw output available through `readToolOutput` when needed.
- **Cleaner terminal rendering.** Assistant Markdown now renders headings, lists, code fences with syntax highlighting, blockquotes, links, emphasis, and wrapped tables in the CLI.
- **Cleaner transcripts.** Consecutive assistant messages in one turn share one visible `haze` header, live tool groups use compact elapsed-time summaries, and repeated identical tool calls are steered back to the model instead of aborting immediately.
- **Scoped instructions.** Haze reads global `~/.claude/CLAUDE.md` plus Haze/project `AGENTS.md` files, and discovers nested `CLAUDE.md`/`AGENTS.md` files only when tools enter their subtree.
- **Less stale state.** Completed task lists clear automatically on the next user turn, and `/init` now guides `AGENTS.md` toward the context-file budget.

Previous releases:

- **0.4.0** — 3-step skill wizard, language-agnostic skill intent extraction, model-managed tasks, leaner command surface, docs site additions.
- **0.3.0** — Docs site redesign, task bar moves above the activity spinner, tasks auto-clear between sessions.
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

Saved settings live in `~/.haze/settings.json`. Providers can include API keys, base URLs, and model lists; local OpenAI-compatible providers can be configured without a key. Use `/provider`, `/model`, and `/settings` to configure everything from inside Haze — there are no environment variables to set.

Haze is intentionally minimal: chat, local tools, context files, sessions, and Markdown skills. Any workflow beyond the core is meant to be grown with the LLM through `/create-skill` (a 3-step wizard: name, role, description). If you want reviews, release prep, deploy checks, debugging rituals, or your team's strange checklist, ask Haze to create a skill and then refine the Markdown.

## Get productive immediately

Open a project and ask for work:

```txt
create a calculator in calc-app in ruby with add subtract multiply divide
```

Haze will inspect, search, write files, fetch public URLs, run commands, and show compact tool activity inline. Small file edits include a colorized line diff with one context line before and after the change; large diffs stay summarized so the transcript does not become a wall of noise. Bash output is reduced by command-aware filters for validation, git, search, JSON, diffs, and noisy logs; failures point at the relevant files, tests, or diagnostics, and raw output remains available by handle when it was omitted. Sessions are saved by default so you can resume the latest workspace conversation with `haze --continue` or `/resume`.

Use `/` to discover commands and skills. `Tab` completes the top suggestion.

Useful starters:

```txt
/init
/create-skill   # then the wizard asks for name, role, and a description like:
                # "review my current branch against main like a senior engineer"
                # "prepare clean git commits from my uncommitted changes"
                # "implement small features with tests and a concise summary"
```

`/init` creates or updates `AGENTS.md` so future sessions understand the project.

## Skills: your workflows, grown while working

Skills are Markdown workflows that Haze creates with `/create-skill` and stores in `~/.haze/skills` so you can inspect or refine them later.

If you do something for the second time, build a skill for it:

```txt
/create-skill
# Wizard: name=branch-diff-review, role="Senior engineer reviewing diffs",
#         description="review the diff between my current branch and main, focusing on bugs, tests, DRY and KISS"
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

They are also available through one `skill` catalog tool. Haze loads one workflow body first and fetches large references only when needed. Skills provide instructions; they do not execute code.

This is the trick: do normal work, notice friction, create a skill, keep going. Your workflow adapts instead of asking you to adapt to the tool. Rude, but in a good way.

## Commands

```txt
/help
/provider
/model
/model <name-or-provider:name>
/model list
/settings
/settings open
/logs [id]
/lsp
/lsp presets
/lsp add <preset>
/lsp add <name> -- <command> [args...]
/lsp enable|disable|remove <name>
/init
/session
/resume
/new
/compact [instructions]
/clear
/exit

/skills
/create-skill
/skill-info <name>
/validate-skill <name-or-dir>
/remove-skill <name> --yes
```

Older `/skill <subcommand>` and `/skills <subcommand>` routing forms were removed; use the direct skill commands above.

CLI flags:

```bash
haze --debug       # show model/tool debug logs and write detailed JSONL logs to ~/.haze/logs
haze --continue    # resume the latest saved session for this workspace
haze --no-session  # run without durable session storage
```

By default, Haze does **not** write the detailed LLM log files under `~/.haze/logs/` (they capture full prompts, messages, and tool I/O). File logging is only enabled with `haze --debug`, which also turns on the on-screen debug panel. Use the `/logs` command to review past log files once logging has been enabled.

## Agent tools

Haze exposes a deliberately small toolset:

- `listFiles` — structured discovery, recursive with cursor pagination when needed.
- `readFile` — read numbered UTF-8 lines in bounded pages, with `nextOffset` when more remain.
- `grep` — structured ripgrep search with a true global result cap and compacted long lines/results.
- `editFile` — unique text replacements, with line-number-prefix tolerance for common model mistakes.
- `replaceLines` — line-range edits when exact replacements are awkward; slightly-too-large EOF ranges are clamped.
- `writeFile` — create files and parent directories.
- `bash` — run tests, builds, git commands, inspections, scripts, installs, and other shell workflows with command-aware output reduction and compact validation output.
- `readToolOutput` — page through full/raw output omitted from an oversized or reduced tool result.
- `fetch` — read a public `http(s)` URL and return readable content (Markdown for docs, pretty JSON, or text). Private/loopback/metadata hosts and non-`http(s)` schemes are blocked; output is bounded and retrievable via `readToolOutput`.
- `writeTasks` — replace the task list at meaningful phase changes; completed lists auto-clear on the next user turn.
- `skill` — load one installed Markdown workflow or one of its references.
- `lspWorkspaceSymbols`, `lspSymbols`, `lspDefinition`, `lspReferences` — optional read-only semantic navigation through user-configured language servers. These tools are exposed only when an enabled LSP command is installed.

Tool calls are grouped in the transcript so you can see what happened without reading a novella. Successful targeted file edits show a compact diff with colored additions/removals and one context line around the change when the diff is small; larger diffs are summarized with a pointer to `git diff`. File-tool failures return structured reason codes and recovery hints. Large bash/search/fetch output is kept behind an in-memory handle so later model calls carry only reduced validation, git, search, diff, JSON, log, or head/tail summaries.

### Optional LSP navigation

Haze can use user-configured stdio Language Server Protocol servers for semantic code navigation. Configure them with `/lsp`; presets currently include TypeScript, Rust, Python, Go, and PHP. Haze does not install language servers for you, and it hides LSP tools from the model unless an enabled server command exists on `PATH`, so projects without LSP still use `grep`, `listFiles`, and `readFile` normally.

Example TypeScript setup:

```bash
npm install -g typescript typescript-language-server
```

```txt
/lsp add typescript
```

## Subagents

Subagents are a delegation feature, not another file operation. When a request clearly splits into independent parallel work, Haze can spin up focused agents with fresh context, let them inspect or act with their own capped tool loop, then fold their concise summaries back into the main conversation.

Use them for parallel investigation across separate areas of a codebase. Do not use them for single sequential tasks where the main agent already has the best context.

## Context files

Haze saves durable workspace sessions in `~/.haze/sessions`. Use `/session` to see the current file, `/new` to start fresh, `/resume` to restore the latest session, and `/compact` to summarize older model context. Sessions also persist compact structured work state: the active goal, touched files, validation evidence, blockers, and next action.

Long turns use bounded tool slices. Older successful tool results are compacted while failures and recent evidence remain verbatim, synthetic Haze control nudges are not persisted as user requests, and token-pressure compaction preserves the structured work state.

Haze loads project instructions from:

- `~/.claude/CLAUDE.md`
- `~/.haze/AGENTS.md`
- `CLAUDE.md` / `AGENTS.md` files from filesystem root to the current workspace

At the same scope, `AGENTS.md` overrides `CLAUDE.md`; global Haze guidance in `~/.haze/AGENTS.md` overrides global Claude guidance in `~/.claude/CLAUDE.md`. Nested `CLAUDE.md` / `AGENTS.md` files below the workspace are scoped: Haze surfaces them only when file tools operate inside that directory or its subdirectories, and mutating tools stop once so the model can review newly discovered scoped instructions before editing.

Use `AGENTS.md` for project conventions, commands, architecture notes, and things future-you does not want to re-explain. `/init` is intentionally budget-aware: it does one small discovery pass, preserves useful existing guidance, and asks for a compact file because context files are injected into every request.

## Safety model

- File tools are restricted to the current workspace.
- File tools follow `.gitignore` by default.
- Ignored files require an explicit override.
- Bash commands are classified and shown with working-directory metadata, but Haze does not use command confirmation gates.
- The `fetch` tool reads public `http(s)` URLs only; private, loopback, link-local, and cloud-metadata hosts and non-`http(s)` schemes are blocked, re-checked on every redirect and after DNS resolution.
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
npm run context:report
```

`npm run context:report` prints estimated system, project-context, and tool-schema tokens without reading `~/.haze`. Pass explicit context-file paths, or use `npm run context:report -- --trace tests/fixtures/agent-traces/long-workflow.json` for offline trace accounting.

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
