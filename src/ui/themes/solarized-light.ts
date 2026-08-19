import type {HazeThemeSpec} from '../theme.js';

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
export const solarizedLight: HazeThemeSpec = {
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
