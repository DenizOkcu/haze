import type {HazeThemeSpec} from '../theme.js';

/**
 * haze's own brand palette and the default theme: the purple-fog look that
 * shipped as haze 1.0's hard-coded colors. Selected when `theme` is unset in
 * settings, and the fallback base for roles another theme omits.
 */
export const purple: HazeThemeSpec = {
  roles: {
    // Terminal background: the docs site's darkest haze tone (--terminal-quote),
    // one step under surfaceBg so the user-message block stays visible on it.
    background: '#171127',
    accent: '#a78bfa',
    accentDim: '#6d28d9',
    border: '#6d28d9',
    info: '#60a5fa',
    muted: '#9ca3af',
    foreground: '#f0eef6',
    command: '#ffb86c',
    success: '#39ff14',
    successBg: '#14331f',
    danger: '#fb7185',
    dangerBg: '#3a1720',
    warning: '#fbbf24',
    surfaceBg: '#1f1633',
    codeBg: '#202124',
  },
};
