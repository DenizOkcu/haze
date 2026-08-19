import type {HazeThemeSpec} from '../theme.js';

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
export const solarizedDark: HazeThemeSpec = {
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
