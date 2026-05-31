# Haze

Haze is a pragmatic, intentionally limited agentic CLI: simple core, file-based skills, explicit approvals.

## Run locally

```bash
npm install
npm run dev
```

Opening Haze starts a full-terminal chat UI. The input field sits at the bottom, model responses stream into the conversation as they arrive, and completed assistant messages render basic Markdown with highlighted code blocks.

First-time setup:

```txt
/login
/model openai/gpt-4o-mini
```

For the MVP, `/login` stores OpenRouter settings in `~/.haze/settings.json`:

```json
{
  "provider": "openrouter",
  "apiKey": "...",
  "baseURL": "https://openrouter.ai/api/v1",
  "model": "openai/gpt-4o-mini"
}
```

Skill management commands are still available:

```bash
npm run dev -- skills list
```

Environment variables also work and override settings:

```bash
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
export HAZE_MODEL=openai/gpt-4o-mini
```

Without an API key or saved OpenRouter login, chat mode will ask you to run `/login`.

## Skills

Default skill locations:

- `~/.haze/skills/`
- `./.haze/skills/` (local overrides global)

A skill is a directory containing `skill.yaml`, optional prompts, and TypeScript tool files. Tools are run in a subprocess via `tsx` and require approval from the user before execution.
