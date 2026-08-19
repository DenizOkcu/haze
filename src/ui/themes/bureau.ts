import type {HazeThemeSpec} from '../theme.js';

/**
 * Port of bureau.zsh-theme [±master ▾●]:
 *   $fg_bold[green]± ✓ $ (prompt) → accent 'green'
 *   $fg_bold[white]%n %~ (user/path) → command 'white' (cwd), foreground
 *   $fg[cyan]▴ (ahead)            → info 'cyan'
 *   $fg_bold[yellow]● (unstaged)  → warning 'yellow'
 *   $fg_bold[red]● (untracked)    → danger 'red'
 */
export const bureau: HazeThemeSpec = {
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
