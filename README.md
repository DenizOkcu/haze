# Haze

Haze is a pragmatic, intentionally limited agentic CLI: simple core, file-based skills, explicit approvals.

## Run locally

```bash
npm install
npm run dev -- skills list
npm run dev -- "list the files in this project"
```

LLM calls use the Vercel AI SDK with OpenAI-compatible config:

```bash
export OPENAI_API_KEY=...
export HAZE_MODEL=gpt-4o-mini
# optional: export OPENAI_BASE_URL=https://...
```

Without an API key, Haze uses a tiny heuristic planner for the bundled `files` skill.

## Skills

Default skill locations:

- `~/.haze/skills/`
- `./.haze/skills/` (local overrides global)

A skill is a directory containing `skill.yaml`, optional prompts, and TypeScript tool files. Tools are run in a subprocess via `tsx` and require approval from the user before execution.
