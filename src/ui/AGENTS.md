# src/ui/AGENTS.md

Reusable Ink components, theme, and input-buffer logic.

## Scope

- Keep reusable presentation components here (`components/*`) and CLI-specific orchestration in `src/cli/**`.
- Components should accept data/callback props and avoid importing settings/session/tool modules directly.
- `theme.ts` is the shared visual palette; avoid hardcoded colors in components when theme values exist.
- `inputBuffer.ts` contains terminal text editing primitives independent of React where possible.

## Component contracts

- `Header.tsx` renders current app/session/model/status summary. Do not expose secrets.
- `TextInput.tsx` handles terminal input/editing interactions; preserve keyboard behavior covered by tests.
- `MarkdownText.tsx` renders Markdown-like assistant/tool text in terminal width constraints. Keep rendering robust for malformed/partial Markdown from streaming models.
- `ErrorView.tsx` should present errors compactly without stack spam unless intentionally surfaced.

## Markdown rendering

- Preserve support for headings, lists, blockquotes, code fences with syntax highlighting, inline emphasis/links/code, horizontal rules, and width-aware tables.
- Do not assume browser CSS/layout; Ink layout and terminal widths are the source of truth.
- Avoid adding dependencies for small Markdown features unless clearly justified.

## Tests

Update:

- `tests/ui/inputBuffer.test.ts` for editing behavior.
- `tests/ui/MarkdownText.test.ts` for Markdown rendering.
- CLI snapshot/formatter tests if component output changes user-visible messages.
