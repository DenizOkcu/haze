# src/ui/AGENTS.md

Last updated: 2026-08-05 for root-level streamed Markdown chunking.

Reusable Ink components, theme, and input-buffer logic.

## Scope

- Keep reusable presentation components here (`components/*`) and CLI-specific orchestration in `src/cli/**`.
- Components should accept data/callback props and avoid importing settings/session/tool modules directly.
- `theme.ts` is the shared visual palette; avoid hardcoded colors in components when theme values exist.
- `inputBuffer.ts` contains terminal text editing primitives independent of React where possible.

## Component contracts

Maintainability focus:

- UI components should render explicit props only; avoid hidden/session state that is set but never displayed.

- `Header.tsx` renders current app/session/model/status summary. Do not expose secrets.
- `TextInput.tsx` handles terminal input/editing interactions and cursor-aware slash/`@path` suggestions; preserve keyboard, Tab, arrow, and Enter completion behavior covered by tests.
- `MarkdownText.tsx` renders Markdown-like assistant/tool text in terminal width constraints and exposes root-level chunking for streamed assistant output. Keep rendering robust for malformed/partial Markdown from streaming models.
- `ErrorView.tsx` should present errors compactly without stack spam unless intentionally surfaced.

## Markdown rendering

- Preserve support for headings, lists, blockquotes, code fences with syntax highlighting, inline emphasis/links/code, horizontal rules, and width-aware tables.
- Treat the final parsed root as unstable while streaming because later text may reclassify it as a setext heading, table, list, or fenced block. Commit only preceding roots; keep source-path leads grouped with their following code fence.
- Do not assume browser CSS/layout; Ink layout and terminal widths are the source of truth.
- Avoid adding dependencies for small Markdown features unless clearly justified.

## Tests

Update:

- `tests/ui/inputBuffer.test.ts` for editing behavior.
- `tests/ui/MarkdownText.test.ts` for Markdown rendering and stable root-level streaming chunks.
- CLI snapshot/formatter tests if component output changes user-visible messages.
