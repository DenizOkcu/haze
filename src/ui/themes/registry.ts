import type {HazeThemeSpec} from '../theme.js';

/**
 * Every built-in theme, keyed by its settings name, in one registry — the
 * single place a theme is declared (see AGENTS.md in this folder for how to
 * add/convert themes). Mirrors how oh-my-zsh discovers `themes/<name>.zsh-theme`
 * by `ZSH_THEME=<name>`; `tests/ui/theme.test.ts` enforces the expected names.
 */

/**
 * haze's own brand palette and the default theme: the purple-fog look that
 * shipped as haze 1.0's hard-coded colors. Selected when `theme` is unset in
 * settings, and the fallback base for roles another theme omits.
 */
const purple: HazeThemeSpec = {
  roles: {
    // Terminal background: the docs site's darkest haze tone (--terminal-quote),
    // one step under surfaceBg so the user-message block stays visible on it.
    background: '#171127',
    accent: '#a78bfa',
    accentDim: '#6d28d9',
    border: '#6d28d9',
    info: '#60a5fa',
    muted: '#9ca3af',
    foreground: '#f0eef6',
    command: '#ffb86c',
    success: '#39ff14',
    successBg: '#14331f',
    danger: '#fb7185',
    dangerBg: '#3a1720',
    warning: '#fbbf24',
    surfaceBg: '#1f1633',
    codeBg: '#202124',
  },
};

/** Light-terminal variant of the haze `purple` palette: every fg/bg pair re-tuned together. */
const light: HazeThemeSpec = {
  roles: {
    // Pure white terminal background; layered surfaces stay slightly off-white.
    background: '#ffffff',
    accent: '#a78bfa',
    accentDim: '#c4b5fd',
    border: '#6b7280',
    info: '#3b82f6',
    muted: '#6b7280',
    foreground: '#1e293b',
    command: '#f59e0b',
    success: '#10b981',
    successBg: '#f0fdf4',
    danger: '#ef4444',
    dangerBg: '#fef2f2',
    warning: '#f59e0b',
    surfaceBg: '#f8fafc',
    codeBg: '#f1f5f9',
  },
};

/**
 * Port of robbyrussell.zsh-theme (the oh-my-zsh default):
 *   $fg_bold[green]➜  → accent 'green'      $fg[cyan]%c        → command 'cyan'
 *   $fg_bold[blue]git:→ info 'blue'         $fg[red]branch     → danger 'red'
 *   $fg[yellow]✗      → warning 'yellow'
 */
const robbyrussell: HazeThemeSpec = {
  roles: {
    // Classic dark-terminal canvas, one step under the xterm-256 234 surfaces.
    background: '#121212',
    accent: 'green',
    accentDim: 'green',
    border: 'black',
    info: 'blue',
    muted: '245',
    foreground: 'default',
    command: 'cyan',
    success: 'green',
    successBg: '22',
    danger: 'red',
    dangerBg: '52',
    warning: 'yellow',
    surfaceBg: '234',
    codeBg: '234',
  },
};

/**
 * Port of af-magic.zsh-theme, which uses xterm-256 slots — kept numeric so
 * the port stays a transliteration of ${FG[105]}», ${FG[032]}%~, ${FG[075]}(,
 * ${FG[078]}branch, ${FG[214]}*, ${FG[237]}dashes, $fg[red]%? ↵.
 */
const afMagic: HazeThemeSpec = {
  roles: {
    // Classic dark-terminal canvas, one step under the xterm-256 234 surfaces.
    background: '#121212',
    accent: '105',
    accentDim: '61',
    border: '237',
    info: '75',
    muted: '237',
    foreground: '251',
    command: '32',
    success: '78',
    successBg: '22',
    danger: 'red',
    dangerBg: '52',
    warning: '214',
    surfaceBg: '234',
    codeBg: '234',
  },
};

/**
 * Port of agnoster.zsh-theme (Powerline segments): AGNOSTER_GIT_CLEAN_BG=green,
 * AGNOSTER_DIR_BG=blue, AGNOSTER_GIT_DIRTY_BG=yellow, AGNOSTER_STATUS_RETVAL_FG=red,
 * AGNOSTER_STATUS_JOB_FG=cyan. The theme's README recommends Solarized, so the
 * port pins a Solarized-dark palette instead of the default Tango approximation.
 * haze has no background segments, so the segment colors become the foreground
 * identity.
 */
const agnoster: HazeThemeSpec = {
  palette: {
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#93a1a1',
    default: '#eee8d5',
  },
  roles: {
    // The theme's README recommends Solarized Dark, so the canvas is base03 and
    // the surfaces move to base02 to stay inside that palette.
    background: '#002b36',
    accent: 'green',
    accentDim: '236',
    border: '236',
    info: 'cyan',
    muted: '245',
    foreground: 'default',
    command: 'blue',
    success: 'green',
    successBg: '22',
    danger: 'red',
    dangerBg: '52',
    warning: 'yellow',
    surfaceBg: '#073642', // base02
    codeBg: '#073642',     // base02
  },
};

/**
 * Port of bira.zsh-theme (the ╭─/╰─ two-line prompt):
 *   $fg[green]%n@%m (user, non-root) → accent 'green'
 *   %B$fg[blue]%~ (cwd, bold)        → command 'blue'
 *   $fg[yellow]‹branch›              → info 'yellow'
 *   $fg[red]● (dirty), %? ↵          → danger 'red'
 *   $fg[green]‹venv›                 → success 'green'
 */
const bira: HazeThemeSpec = {
  roles: {
    // Classic dark-terminal canvas, one step under the xterm-256 234 surfaces.
    background: '#121212',
    accent: 'green',
    accentDim: 'green',
    border: '236',
    info: 'yellow',
    muted: '245',
    foreground: 'default',
    command: 'blue',
    success: 'green',
    successBg: '22',
    danger: 'red',
    dangerBg: '52',
    warning: 'yellow',
    surfaceBg: '234',
    codeBg: '234',
  },
};

/**
 * Port of bureau.zsh-theme [±master ▾●]:
 *   $fg_bold[green]± ✓ $ (prompt) → accent 'green'
 *   $fg_bold[white]%n %~ (user/path) → command 'white' (cwd), foreground
 *   $fg[cyan]▴ (ahead)            → info 'cyan'
 *   $fg_bold[yellow]● (unstaged)  → warning 'yellow'
 *   $fg_bold[red]● (untracked)    → danger 'red'
 */
const bureau: HazeThemeSpec = {
  roles: {
    // Classic dark-terminal canvas, one step under the xterm-256 234 surfaces.
    background: '#121212',
    accent: 'green',
    accentDim: '236',
    border: '236',
    info: 'cyan',
    muted: '245',
    foreground: 'default',
    command: 'white',
    success: 'green',
    successBg: '22',
    danger: 'red',
    dangerBg: '52',
    warning: 'yellow',
    surfaceBg: '234',
    codeBg: '235',
  },
};

/**
 * Port of clean.zsh-theme:
 *   $fg_bold[white]%n (user)     → accent 'white'
 *   $fg_bold[blue]%c/ (cwd)      → command 'blue'
 *   $fg_bold[blue]( git branch   → info 'blue', branch $fg[yellow] → warning
 *   $fg_bold[red]✗ (dirty)       → danger 'red'
 */
const clean: HazeThemeSpec = {
  roles: {
    // Classic dark-terminal canvas, one step under the xterm-256 234 surfaces.
    background: '#121212',
    accent: 'white',
    accentDim: '236',
    border: '236',
    info: 'blue',
    muted: '245',
    foreground: 'default',
    command: 'blue',
    success: 'green',
    successBg: '22',
    danger: 'red',
    dangerBg: '52',
    warning: 'yellow',
    surfaceBg: '234',
    codeBg: '234',
  },
};

/**
 * Port of cloud.zsh-theme: $fg_bold[cyan]☁, $fg[green]%c,
 * $fg[green][$fg[cyan]branch, $fg[yellow]⚡ dirty.
 */
const cloud: HazeThemeSpec = {
  roles: {
    // Classic dark-terminal canvas, one step under the xterm-256 234 surfaces.
    background: '#121212',
    accent: 'cyan',
    accentDim: '236',
    border: '236',
    info: 'blue',
    muted: '245',
    foreground: 'default',
    command: 'green',
    success: 'green',
    successBg: '22',
    danger: 'red',
    dangerBg: '52',
    warning: 'yellow',
    surfaceBg: '234',
    codeBg: '234',
  },
};

/**
 * Port of dst.zsh-theme:
 *   $fg[magenta]%n (user)   → accent 'magenta'
 *   $fg[yellow]%m (host)    → warning 'yellow'
 *   $fg_bold[blue]%~ (cwd)  → command 'blue'
 *   $fg[green]branch prefix → info 'green'   $fg[red]! (dirty) → danger 'red'
 *   $fg[green][%*] (clock)  → success 'green'
 */
const dst: HazeThemeSpec = {
  roles: {
    // Classic dark-terminal canvas, one step under the xterm-256 234 surfaces.
    background: '#121212',
    accent: 'magenta',
    accentDim: 'magenta',
    border: '236',
    info: 'green',
    muted: '245',
    foreground: 'default',
    command: 'blue',
    success: 'green',
    successBg: '22',
    danger: 'red',
    dangerBg: '52',
    warning: 'yellow',
    surfaceBg: '234',
    codeBg: '234',
  },
};

/**
 * Port of fishy.zsh-theme: $fg[green]%n and cwd (user_color='green'),
 * $fg_bold[red] exit status, and its git-status markers (+ green, ! blue,
 * - red, > magenta, # yellow, ? cyan).
 */
const fishy: HazeThemeSpec = {
  roles: {
    // Classic dark-terminal canvas, one step under the xterm-256 234 surfaces.
    background: '#121212',
    accent: 'green',
    accentDim: 'green',
    border: '236',
    info: 'cyan',
    muted: '245',
    foreground: 'default',
    command: 'green',
    success: 'green',
    successBg: '22',
    danger: 'red',
    dangerBg: '52',
    warning: 'yellow',
    surfaceBg: '234',
    codeBg: '235',
  },
};

/**
 * Port of steeef.zsh-theme (Steve Losh's Prose style), using its 256-color
 * branch — kept numeric so the port stays a transliteration:
 *   %F{135}%n (user, purple)   → accent '135'
 *   %F{166}%m (host, orange), unstaged ● → warning '166'
 *   %F{118}%~ (cwd, limegreen) → command/success '118'
 *   %F{81}branch (turquoise)   → info '81'
 *   %F{161}● (untracked, hotpink) → danger '161'
 */
const steeef: HazeThemeSpec = {
  roles: {
    // Classic dark-terminal canvas, one step under the xterm-256 234 surfaces.
    background: '#121212',
    accent: '135',
    accentDim: '61',
    border: '236',
    info: '81',
    muted: '245',
    foreground: 'default',
    command: '118',
    success: '118',
    successBg: '22',
    danger: '161',
    dangerBg: '52',
    warning: '166',
    surfaceBg: '234',
    codeBg: '235',
  },
};

/**
 * Port of Solarized Dark (Ethan Schoonover, ethanschoonover.com/solarized).
 * Solarized is a terminal *palette*, not a prompt theme, so the port pins the
 * canonical 16-color mapping as `palette` and writes roles as zsh names.
 *
 * Base tones (dark mode): bg base03, emphasis bg base02, body base0,
 * comments base01. Accent colors are identical in both modes by design —
 * each Solarized accent maps to exactly one haze role:
 *   blue #268bd2 → accent   violet #6c71c4 → accentDim   yellow #b58900 → command
 *   cyan #2aa198 → info     green #859900  → success     orange #cb4b16 → warning
 *   red #dc322f  → danger
 * All backgrounds use base02 ("bg highlight"), Solarized's own surface tone
 * for selection/diff regions: the accent foreground carries the meaning.
 */
const solarizedDark: HazeThemeSpec = {
  palette: {
    black: '#002b36',   // base03 (ANSI slot 0)
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',   // base2 (ANSI slot 7)
    default: '#839496', // base0 — dark-mode body text
  },
  roles: {
    background: '#002b36', // base03 — the dark-mode canvas
    accent: 'blue',
    accentDim: '#6c71c4', // violet
    border: '#586e75',    // base01 — chrome structure
    info: 'cyan',
    muted: '#586e75',     // base01 — dark-mode comments
    foreground: 'default',
    command: 'yellow',
    success: 'green',
    successBg: '#073642', // base02
    danger: 'red',
    dangerBg: '#073642',  // base02
    warning: '#cb4b16',   // orange
    surfaceBg: '#073642', // base02
    codeBg: '#073642',    // base02
  },
};

/**
 * Port of Solarized Light (Ethan Schoonover, ethanschoonover.com/solarized).
 * Same accent palette as `solarized-dark` — Solarized's two modes swap only
 * the base tones, never the accent colors:
 *   dark: bg base03, surfaces base02, body base0, comments base01
 *   light: bg base3, surfaces base2, body base00, comments base1
 * Role → accent mapping is identical to solarized-dark (see its comment);
 * orange/red gain contrast on light while yellow softens, exactly as in the
 * source palette.
 */
const solarizedLight: HazeThemeSpec = {
  palette: {
    black: '#002b36',   // base03 (ANSI slot 0)
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',   // base2 (ANSI slot 7)
    default: '#657b83', // base00 — light-mode body text
  },
  roles: {
    background: '#fdf6e3', // base3 — the light-mode canvas (full Solarized Light)
    accent: 'blue',
    accentDim: '#6c71c4', // violet
    border: '#93a1a1',    // base1 — chrome structure on light
    info: 'cyan',
    muted: '#93a1a1',     // base1 — light-mode comments
    foreground: 'default',
    command: 'yellow',
    success: 'green',
    successBg: '#eee8d5', // base2
    danger: 'red',
    dangerBg: '#eee8d5',  // base2
    warning: '#cb4b16',   // orange
    surfaceBg: '#eee8d5', // base2
    codeBg: '#eee8d5',    // base2
  },
};

/** Every built-in theme, keyed by its settings name. Key order drives the `/themes` picker listing. */
export const THEMES: Record<string, HazeThemeSpec> = {
  purple,
  light,
  'af-magic': afMagic,
  agnoster,
  bira,
  bureau,
  clean,
  cloud,
  dst,
  fishy,
  robbyrussell,
  'solarized-dark': solarizedDark,
  'solarized-light': solarizedLight,
  steeef,
};

/** The base theme other themes inherit omitted roles from (also the default). */
export const BASE_THEME_SPEC = purple;
