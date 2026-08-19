import type {HazeThemeSpec} from '../theme.js';

/**
 * Port of dst.zsh-theme:
 *   $fg[magenta]%n (user)   → accent 'magenta'
 *   $fg[yellow]%m (host)    → warning 'yellow'
 *   $fg_bold[blue]%~ (cwd)  → command 'blue'
 *   $fg[green]branch prefix → info 'green'   $fg[red]! (dirty) → danger 'red'
 *   $fg[green][%*] (clock)  → success 'green'
 */
export const dst: HazeThemeSpec = {
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
