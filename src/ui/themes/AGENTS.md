# src/ui/themes/AGENTS.md

Last updated: 2026-08-19 for the 1.1.0 release.

Instructions for coding agents converting themes into haze. One file per theme
here, exactly like oh-my-zsh's `themes/` folder holds one `.zsh-theme` per
theme. Haze's `default` theme is `purple.ts`.

## Layout rules

- One theme per file: `src/ui/themes/<name>.ts`, kebab-case, named after the
  source theme (`robbyrussell.ts`, `af-magic.ts`). The exported `const` is the
  camelCase form (`afMagic`).
- Each file exports a `HazeThemeSpec` and starts with a comment quoting the
  source lines it ports (see any existing file).
- Register the import in `index.ts` under a key that **equals the file name**
  (minus `.ts`). `tests/ui/theme.test.ts` enforces folder↔registry parity.
- Never invent colors: every role value must come from the source theme
  (or be an explicitly documented neutral filler for roles the source lacks).

## Anatomy

```ts
import type {HazeThemeSpec} from '../theme.js';

export const mytheme: HazeThemeSpec = {
  // Optional: pin the terminal palette the source assumes (e.g. Solarized).
  // Keys: zsh color names. Values: '#rrggbb' only.
  palette: {green: '#859900', /* ... */},
  roles: {
    background: '#121212', // terminal default background — required for a full port
    accent: 'green',   // zsh color name  ≡ $fg[green]
    warning: '214',    // xterm-256 index ≡ ${FG[214]} / %F{214}
    command: '#ff8800'// truecolor hex   ≡ %F{#ff8800}
    // roles omitted here inherit purple's values
  },
};
```

Color values accept exactly the three notations above (zsh name, `'nnn'`
256-index string, `#rrggbb`). Bold/italic/underline are **not** colors — drop
them during conversion. Alpha (`#rrggbbaa`) is unsupported: strip the alpha.

## Role reference (what each token styles in haze)

| Role | Styles in haze | omz source segment | VS Code scope / color | Sublime (TextMate) scope |
|---|---|---|---|---|
| `background` | Terminal default background (OSC 11; canvas under everything) | the assumed terminal background | `editor.background` | theme `background` |
| `accent` | App name, tool names, list markers, links | prompt symbol / user segment (`$fg_bold[green]➜`) | `keyword`, `storage.type` | `keyword`, `storage` |
| `accentDim` | HR rules, heading underlines, table borders | separator rules (`${FG[237]}` dashes) | `punctuation` (dimmed) | `punctuation.separator` |
| `border` | Input box / panel borders | segment dividers | `focusBorder`, `panel.border` | — |
| `info` | Tool headers, secondary emphasis | branch/parens segments, `AGNOSTER_STATUS_JOB_FG` | `entity.name.function`, `support.function` | `entity.name.function` |
| `muted` | Hints, timestamps, elided lines | muted separators (`${FG[237]}`) | `comment` | `comment` |
| `foreground` | Primary text (task titles, diff code) | body text `$fg[default]` | `editor.foreground` | source `background` pair fg |
| `command` | Slash commands, paths, handles | cwd segment (`$fg[cyan]%c`) | `entity.name.tag`, `variable.other` | `entity.name.tag` |
| `success` (+`successBg`) | ✓ icons, completions; added diff lines | exit-ok / clean-git / venv segment | `string`, `constant.other` | `string` |
| `danger` (+`dangerBg`) | ✗ icons, removed diff lines | exit-fail / `$fg_bold[red]` | `invalid`, `markup.deleted` | `invalid`, `markup.deleted` |
| `warning` | Warnings, in-progress states, inline code | git dirty marker (`$fg[yellow]✗`) | `constant.numeric`, `markup.changed` | `constant.numeric` |
| `surfaceBg` | Quoted/user-message surfaces | — (pick near-black) | `sideBar.background`-ish dark tone | — |
| `codeBg` | Code fence / inline code background | — (pick near-black) | `editor.background` | theme `background` |

Backgrounds: `background` is the terminal canvas and `foreground` the body
text — haze adopts both as the terminal defaults via OSC 10/11 on startup and
restores them (OSC 110/111) on exit (terminals without support simply ignore
it). Because unstyled text inherits the terminal foreground, the two MUST be
themed as a pair: a light background demands dark text and vice versa — the
test suite enforces WCAG >= 3:1 between them per theme. Keep layering in
mind: `background` < `surfaceBg`/`codeBg` so surfaces stay visible on the
canvas. oh-my-zsh themes assume a dark terminal
and never set backgrounds, so dark ports reuse the established near-black
pairs — `background: '#121212'`, `successBg: '22'`, `dangerBg: '52',
`surfaceBg: '234'`, `codeBg: '234'` (or `'235'`) — unless the source defines
real background colors (a full VS Code/Sublime port must take its `background`
from the source: that is the canvas). Light themes (like `light.ts` or
`solarized-light.ts`) redefine fg/bg **pairs** together, never one side.

## Converting an oh-my-zsh theme (`themes/<name>.zsh-theme`)

1. Read the source and list every color reference:
   `$fg[name]`, `$fg_bold[name]`, `${FG[nnn]}`, `%F{nnn}`, `%F{#hex}`,
   and `$fg_no_bold[name]`. The name/number is all you keep.
2. Map prompt segments to roles (table above). Typical transliterations:
   - prompt symbol / user@host → `accent`
   - cwd (`%c`, `%~`) → `command`
   - git branch → `info` (or `accent` if the branch is the theme's signature)
   - dirty/clean markers, unstaged dots → `warning` / `success`
   - return-code / untracked / FAIL → `danger`
   - separators, clocks, history numbers → `muted`
3. Keep numeric slots numeric (`'214'`), not pre-converted hex — the port then
   reads as a transliteration of the source.
4. If the theme assumes a specific terminal palette (agnoster's README says
   Solarized), pin it via `palette`; otherwise rely on the default Tango
   approximation of zsh names.
5. If the theme has a 16-color fallback branch (e.g. steeef), port the
   256-color branch.

Example — robbyrussell's `$fg_bold[green]➜`, `$fg[cyan]%c`, `$fg[yellow]✗`
become `accent: 'green'`, `command: 'cyan'`, `warning: 'yellow'`.

## Converting a VS Code theme (`*.json`)

1. Normalize hex forms: `#rgb` → `#rrggbb` (duplicate digits), `#rrggbbaa` →
   strip alpha. Named CSS colors are not supported; skip or convert to hex.
2. `colors.editor.background` → `background` (the terminal canvas);
   a slightly lighter panel tone → `codeBg` and `surfaceBg`;
   `colors.editor.foreground` → `foreground`; `focusBorder` → `border`;
   `editorLineNumber.foreground` → `muted`.
3. `tokenColors` (TextMate): pick the most specific match per scope using the
   table above (`keyword` → `accent`, `string` → `success`,
   `comment` → `muted`, `entity.name.function` → `info`,
   `constant.numeric` → `warning`, `invalid` → `danger`,
   `variable`/`entity.name.tag` → `command`).
4. `terminal.ansiGreen` etc. may pin `palette` slots — that is the direct
   equivalent of the zsh named colors.

## Converting a Sublime Text theme (`*.tmTheme`)

`.tmTheme` is an XML plist of TextMate scopes → `settings.foreground` values.

1. Parse the `<dict>` entries: `<key>scope</key><string>…</string>` followed by
   `<key>settings</key>` containing `foreground` (hex) and optionally
   `background`.
2. Map scopes exactly like VS Code `tokenColors` (same TextMate taxonomy).
3. The global `background` setting → `background` (the terminal canvas) with
   `codeBg` a step lighter; keep its fg partner as `foreground`.
4. XML-unescape entities (`&amp;` etc.) in scope names before matching.

## Validation

After adding/editing a theme:

```bash
npm run typecheck
npx vitest run tests/ui/theme.test.ts
```

The test suite resolves every registered theme (all roles must produce valid
`#rrggbb`), enforces folder↔registry parity, and checks famous ports' colors.
For a visual check, render swatches from `dist/`.
Update the valid-names assertion in `tests/ui/theme.test.ts` when the registry
grows.
