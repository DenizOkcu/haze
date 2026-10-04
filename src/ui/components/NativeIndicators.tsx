import React from 'react';
import {Spinner, StatusMessage, ThemeProvider, defaultTheme, extendTheme} from '@inkjs/ui';
import {theme, type HazeTheme} from '../theme.js';

export type NoticeVariant = 'success' | 'error' | 'warning' | 'info';

/** Map library indicators to the current palette, never its default colors. */
export function indicatorTheme(palette: HazeTheme, spinnerColor = palette.command) {
  const colors = {success: palette.success, error: palette.danger, warning: palette.warning, info: palette.info};
  return extendTheme(defaultTheme, {components: {
    Spinner: {styles: {
      container: () => ({flexShrink: 0}),
      frame: () => ({color: spinnerColor}),
    }},
    StatusMessage: {styles: {
      container: () => ({gap: 1, flexShrink: 0, width: '100%', overflow: 'hidden'}),
      icon: ({variant}: {variant: NoticeVariant}) => ({color: colors[variant]}),
      message: () => ({color: palette.foreground, wrap: 'truncate-end'}),
    }},
  }});
}

/** A layout element: render beside Text, not nested inside it. */
export function ActivitySpinner({color = theme.command}: {color?: string}) {
  return <ThemeProvider theme={indicatorTheme(theme, color)}><Spinner type="dots" /></ThemeProvider>;
}

export function StatusNotice({variant, children}: {variant: NoticeVariant; children: React.ReactNode}) {
  return <ThemeProvider theme={indicatorTheme(theme)}>
    <StatusMessage variant={variant}>{children}</StatusMessage>
  </ThemeProvider>;
}
