# src/ui/AGENTS.md

Last updated: 2026-10-07 for the 1.5.1 release.

Reusable Ink components, theme, and input-buffer logic.

## Scope

- Keep reusable presentation components here (`components/*`) and CLI-specific orchestration in `src/cli/**`.
- Components should accept data/callback props and avoid importing settings/session/tool modules directly.
- `theme.ts` is the shared visual palette (vocabulary + resolver); the themes themselves live one-per-file in `src/ui/themes/` (see its AGENTS.md for converting oh-my-zsh / VS Code / Sublime themes). `terminalColors.ts` owns the OSC 10/11 terminal-default adoption/restore (and the `/themes` live re-apply); helpers are write-only so they never race Ink for stdin. Avoid hardcoded colors in components when theme values exist. Theme values use the oh-my-zsh/zsh color vocabulary (zsh color names like `cyan`, xterm-256 indices like `'214'`, or `#rrggbb` hex).
- `inputBuffer.ts` contains terminal text editing primitives independent of React where possible. `textGeometry.ts` keeps UTF-16 storage/paste offsets separate from grapheme boundaries and terminal-cell widths; use the direct `string-width` dependency for width calculations.

## Component contracts

Maintainability focus:

- UI components should render explicit props only; avoid hidden/session state that is set but never displayed.

- `Header.tsx` renders current app/session/model/status summary. Do not expose secrets.
- `TextInput.tsx` owns typed keys via `useInput` and bracketed data via `usePaste`; disabled paste is discarded without shortcut dispatch. Its explicit input/suggestion row allowances and equality-guarded demand reporting feed the whole-frame allocator. Input display sanitization never mutates submitted data, and masked values must never enter history. The slash/`@path` suggestion layers (filtering, async mention fetch with cancellation, selection state) live in `useInputSuggestions.ts`. Preserve keyboard, Tab, arrow, and Enter completion behavior covered by tests.
- `MarkdownText.tsx` renders Markdown-like assistant/tool text in terminal width constraints and exposes root-level chunking for streamed assistant output. `StreamingMarkdownText.tsx` uses that same renderer offscreen to produce formatted rows before live-tail clamping; run its synchronous Ink render outside React render/commit phases. Keep rendering robust for malformed/partial Markdown from streaming models.
- `NativeIndicators.tsx` hosts the Ink-8-native activity indicators — `ActivitySpinner` (cli-spinner-compatible `dots` frames on Ink's shared animation timer), `StatusNotice` (library `StatusMessage` remapped onto the haze palette via `indicatorTheme`, never the library default colors), and the screen-reader static-glyph path. Animated components consolidate into one render cycle under `maxFps`; there are no per-spinner `setInterval` timers.
- `WizardChoices.tsx` projects the wizard's selected suggestion window into a passive `@inkjs/ui` Select: the existing input editor keeps the single keyboard owner (free-form typing, filter, Tab completion, escape paths stay intact) and no second wizard state machine or parallel key listener is introduced.
- Errors should be presented compactly without stack spam unless intentionally surfaced.

- Width-change transcript replay belongs to the CLI: only its width-keyed `<Static>` remounts. Re-render settled Markdown at the new width without resetting `TextInput` drafts or active turn state. `tests/cli/chat/resizeBoundary.test.tsx` covers replay and draft preservation.

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
