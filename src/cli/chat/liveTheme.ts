import {useEffect} from 'react';
import type {HazeSettings} from '../../config/settings.js';
import {setActiveTheme, resolveTheme, theme, DEFAULT_THEME_NAME} from '../../ui/theme.js';
import {applyTerminalColors} from '../../ui/terminalColors.js';

/**
 * Live theme switching, extracted from `ChatScreen` (ARCH-05): whenever the
 * settings' theme name changes (/themes), re-resolve and adopt it so the whole
 * UI repaints without a restart. Ink <Static> history stays as-rendered, so
 * already-printed text keeps its old colors; the terminal defaults (OSC 10/11)
 * follow the new theme. Skipped until `settingsThemeLoadedRef` is set —
 * `chatCommand()` already resolved the theme before the first render, and the
 * pre-load {} state would briefly flash the default theme.
 */
export function useLiveTheme(settings: HazeSettings, stoppingRef: React.MutableRefObject<boolean>, settingsThemeLoadedRef: React.MutableRefObject<boolean>): void {
  const activeThemeName = settings.theme ?? DEFAULT_THEME_NAME;
  useEffect(() => {
    if (!settingsThemeLoadedRef.current || stoppingRef.current) return;
    try {
      setActiveTheme(resolveTheme(activeThemeName));
      applyTerminalColors(theme.foreground, theme.background);
    } catch {
      // Malformed theme names were reported at startup; keep the resolved default.
    }
  }, [activeThemeName, stoppingRef, settingsThemeLoadedRef]);
}
