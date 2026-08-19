import type {HazeThemeSpec} from '../theme.js';

/**
 * Port of robbyrussell.zsh-theme (the oh-my-zsh default):
 *   $fg_bold[green]➜  → accent 'green'      $fg[cyan]%c        → command 'cyan'
 *   $fg_bold[blue]git:→ info 'blue'         $fg[red]branch     → danger 'red'
 *   $fg[yellow]✗      → warning 'yellow'
 */
export const robbyrussell: HazeThemeSpec = {
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
