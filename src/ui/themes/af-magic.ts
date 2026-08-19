import type {HazeThemeSpec} from '../theme.js';

/**
 * Port of af-magic.zsh-theme, which uses xterm-256 slots — kept numeric so
 * the port stays a transliteration of ${FG[105]}», ${FG[032]}%~, ${FG[075]}(,
 * ${FG[078]}branch, ${FG[214]}*, ${FG[237]}dashes, $fg[red]%? ↵.
 */
export const afMagic: HazeThemeSpec = {
  roles: {
    // Classic dark-terminal canvas, one step under the xterm-256 234 surfaces.
    background: '#121212',
    accent: '105',
    accentDim: '61',
    border: '237',
    info: '75',
    muted: '237',
    foreground: '251',
    command: '32',
    success: '78',
    successBg: '22',
    danger: 'red',
    dangerBg: '52',
    warning: '214',
    surfaceBg: '234',
    codeBg: '234',
  },
};
