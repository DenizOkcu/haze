import type {HazeThemeSpec} from '../theme.js';

/**
 * Port of clean.zsh-theme:
 *   $fg_bold[white]%n (user)     → accent 'white'
 *   $fg_bold[blue]%c/ (cwd)      → command 'blue'
 *   $fg_bold[blue]( git branch   → info 'blue', branch $fg[yellow] → warning
 *   $fg_bold[red]✗ (dirty)       → danger 'red'
 */
export const clean: HazeThemeSpec = {
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
