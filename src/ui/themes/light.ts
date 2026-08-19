import type {HazeThemeSpec} from '../theme.js';

/** Light-terminal variant of the haze `purple` palette: every fg/bg pair re-tuned together. */
export const light: HazeThemeSpec = {
  roles: {
    // Pure white terminal background; layered surfaces stay slightly off-white.
    background: '#ffffff',
    accent: '#a78bfa',
    accentDim: '#c4b5fd',
    border: '#6b7280',
    info: '#3b82f6',
    muted: '#6b7280',
    foreground: '#1e293b',
    command: '#f59e0b',
    success: '#10b981',
    successBg: '#f0fdf4',
    danger: '#ef4444',
    dangerBg: '#fef2f2',
    warning: '#f59e0b',
    surfaceBg: '#f8fafc',
    codeBg: '#f1f5f9',
  },
};
