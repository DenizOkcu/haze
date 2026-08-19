import type {HazeThemeSpec} from '../theme.js';

/**
 * Port of agnoster.zsh-theme (Powerline segments): AGNOSTER_GIT_CLEAN_BG=green,
 * AGNOSTER_DIR_BG=blue, AGNOSTER_GIT_DIRTY_BG=yellow, AGNOSTER_STATUS_RETVAL_FG=red,
 * AGNOSTER_STATUS_JOB_FG=cyan. The theme's README recommends Solarized, so the
 * port pins a Solarized-dark palette instead of the default Tango approximation.
 * haze has no background segments, so the segment colors become the foreground
 * identity.
 */
export const agnoster: HazeThemeSpec = {
  palette: {
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#93a1a1',
    default: '#eee8d5',
  },
  roles: {
    // The theme's README recommends Solarized Dark, so the canvas is base03 and
    // the surfaces move to base02 to stay inside that palette.
    background: '#002b36',
    accent: 'green',
    accentDim: '236',
    border: '236',
    info: 'cyan',
    muted: '245',
    foreground: 'default',
    command: 'blue',
    success: 'green',
    successBg: '22',
    danger: 'red',
    dangerBg: '52',
    warning: 'yellow',
    surfaceBg: '#073642', // base02
    codeBg: '#073642',     // base02
  },
};
