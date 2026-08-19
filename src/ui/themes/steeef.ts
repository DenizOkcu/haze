import type {HazeThemeSpec} from '../theme.js';

/**
 * Port of steeef.zsh-theme (Steve Losh's Prose style), using its 256-color
 * branch — kept numeric so the port stays a transliteration:
 *   %F{135}%n (user, purple)   → accent '135'
 *   %F{166}%m (host, orange), unstaged ● → warning '166'
 *   %F{118}%~ (cwd, limegreen) → command/success '118'
 *   %F{81}branch (turquoise)   → info '81'
 *   %F{161}● (untracked, hotpink) → danger '161'
 */
export const steeef: HazeThemeSpec = {
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
