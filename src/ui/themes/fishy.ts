import type {HazeThemeSpec} from '../theme.js';

/**
 * Port of fishy.zsh-theme: $fg[green]%n and cwd (user_color='green'),
 * $fg_bold[red] exit status, and its git-status markers (+ green, ! blue,
 * - red, > magenta, # yellow, ? cyan).
 */
export const fishy: HazeThemeSpec = {
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
