import type {HazeThemeSpec} from '../theme.js';

/**
 * Port of cloud.zsh-theme: $fg_bold[cyan]☁, $fg[green]%c,
 * $fg[green][$fg[cyan]branch, $fg[yellow]⚡ dirty.
 */
export const cloud: HazeThemeSpec = {
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
