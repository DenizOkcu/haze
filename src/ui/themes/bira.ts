import type {HazeThemeSpec} from '../theme.js';

/**
 * Port of bira.zsh-theme (the ╭─/╰─ two-line prompt):
 *   $fg[green]%n@%m (user, non-root) → accent 'green'
 *   %B$fg[blue]%~ (cwd, bold)        → command 'blue'
 *   $fg[yellow]‹branch›              → info 'yellow'
 *   $fg[red]● (dirty), %? ↵          → danger 'red'
 *   $fg[green]‹venv›                 → success 'green'
 */
export const bira: HazeThemeSpec = {
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
