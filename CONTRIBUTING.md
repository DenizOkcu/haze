# Contributing to Haze

## Setup

```bash
git clone https://github.com/DenizOkcu/haze.git
cd haze
npm install
```

## Development

```bash
npm run dev          # Run CLI in development mode (tsx)
npm run typecheck    # Type-check without building
npm run build        # Clean + compile to dist/
npm test             # Run unit tests
npm run lint         # Check code style
```

## Project Structure

```
src/
  cli/          CLI entrypoint, chat UI, streaming loop, and slash commands
  llm/          AI model client, built-in tools, and prompts
  core/         Agent goal/completion logic, bash classification, validation parsing, and subagents
  skills/       Skill loading, registry, installer, and scaffold builder
  config/       Settings, paths, sessions, history, and context files
  ui/           React/Ink terminal UI components
  utils/        Shared utilities
```

## Conventions

- **TypeScript strict mode** — all code must pass `tsc --noEmit`
- **ESM only** — use `import`/`export`, no `require()`. File imports need `.js` extensions
- **No classes unless stateful** — prefer plain functions
- **No comments unless non-obvious** — code should be self-documenting
- **Zod for runtime validation** — skill manifests use Zod schemas
- **Ink/React for terminal UI** — only `src/ui/` should have JSX

## Adding a Slash Command

1. Add handler in `src/cli/commands/commands.ts`
2. Add command description to `/help` output
3. Add test for the command

Skill management commands also live here under `/skills ...`; do not add new top-level `haze skills ...` Commander subcommands unless the product direction changes.

## Input and Cancellation

- `Esc` clears the input field while typing.
- While Haze is thinking, `Esc` aborts the active turn through the AI SDK `abortSignal` path and re-enables input.
- Long prompts wrap across multiple visible input lines. Preserve cursor behavior when changing `TextInput`, including vertical movement through wrapped lines and compacted paste-block cursor mapping.

## Adding a Tool

Haze is aimed at expert users. Do not add command-confirmation gates for normal bash execution; prefer transparent classification, structured output, and clear transcript rendering. Ask the user only when the requested product or implementation decision is ambiguous.

1. Define tool in `src/llm/hazeTools.ts` using the Vercel AI SDK `tool()` function.
2. Add or update the tool description in `src/llm/systemPrompt.ts`.
3. Add display formatting in `src/cli/commands/formatters.ts` and, if the result needs rich transcript rendering, in `src/cli/commands/streaming.ts` / `src/cli/commands/chat.tsx`.
4. Keep mutating file tools workspace-scoped, `.gitignore`-aware, and structured in their success/failure output. For targeted edits, return compact added/removed counts, reason codes on recoverable failures, and only small inline diffs.
5. Add tests.

## Pull Requests

- Run `npm run typecheck && npm test && npm run lint` before pushing
- One concern per PR — don't bundle unrelated changes
- Write tests for new logic
- Keep PRs small and focused

## Reporting Issues

- Include Node.js version (`node --version`)
- Include Haze version (`haze --version`)
- Include steps to reproduce
- Include relevant output or error messages
