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
haze skills list
haze skills info <name>
haze skills validate <dir>
haze install-skill <githubRepo>
haze build-skill <description>
```

Chat commands:

```txt
/help
/login
/model <name>
/model
/settings
/clear
/exit
```

Input conveniences:

- `↑` / `↓` browse persisted input history.
- `←` / `→` move the cursor.
- `Esc` clears the input field.
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

Tool calls are shown inline in the chat transcript so you can see what Haze is doing.

## Safety model

- File tools are restricted to the current workspace.
- File tools follow `.gitignore` by default.
- Ignored files can still be accessed when explicitly needed by using the tool's ignored-file override.
- Haze is prompted to ask before destructive actions.
- Bash is powerful; review commands shown in the transcript, especially in early releases.

## Skills

Default skill locations:

- `~/.haze/skills/`
- `./.haze/skills/` local overrides global

A skill is a directory containing `skill.yaml`, optional prompts, and TypeScript tool files. Skill tools run in a subprocess via `tsx`.

## Development

```bash
npm install
npm run typecheck
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
