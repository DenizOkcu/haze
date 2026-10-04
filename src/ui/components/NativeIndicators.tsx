import React from 'react';
import {Box, Text, useAnimation, useIsScreenReaderEnabled} from 'ink';
import {StatusMessage, ThemeProvider, defaultTheme, extendTheme} from '@inkjs/ui';
import {theme, type HazeTheme} from '../theme.js';

export type NoticeVariant = 'success' | 'error' | 'warning' | 'info';

// Matches cli-spinners' `dots` (the @inkjs/ui Spinner type haze used), so the
// visual cadence is unchanged after moving to Ink's shared animation timer.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const SPINNER_INTERVAL_MS = 80;

/** Map library indicators to the current palette, never its default colors. */
export function indicatorTheme(palette: HazeTheme) {
  const colors = {success: palette.success, error: palette.danger, warning: palette.warning, info: palette.info};
  return extendTheme(defaultTheme, {components: {
    StatusMessage: {styles: {
      container: () => ({gap: 1, flexShrink: 0, width: '100%', overflow: 'hidden'}),
      icon: ({variant}: {variant: NoticeVariant}) => ({color: colors[variant]}),
      message: () => ({color: palette.foreground, wrap: 'truncate-end'}),
    }},
  }});
}

/** A layout element: render beside Text, not nested inside it. */
export function ActivitySpinner({color = theme.command}: {color?: string}) {
  const screenReader = useIsScreenReaderEnabled();
  // Ink 8's shared animation timer: every animated component consolidates
  // into one render cycle (throttled by maxFps) instead of per-spinner timers.
  const {frame} = useAnimation({interval: SPINNER_INTERVAL_MS});
  const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!;
  // Screen readers announce frame churn as noise; hold a static marker.
  return <Box flexShrink={0}><Text color={color}>{screenReader ? '·' : glyph}</Text></Box>;
}

export function StatusNotice({variant, children}: {variant: NoticeVariant; children: React.ReactNode}) {
  return <ThemeProvider theme={indicatorTheme(theme)}>
    <StatusMessage variant={variant}>{children}</StatusMessage>
  </ThemeProvider>;
}
