import React from 'react';
import {Select, ThemeProvider, defaultTheme, extendTheme} from '@inkjs/ui';
import {theme, type HazeTheme} from '../theme.js';
import {safeInputDisplay} from '../textGeometry.js';
import type {TextInputSuggestion} from './TextInput.js';

/** Rebuild from the live palette; Static transcript and terminal defaults are untouched. */
export function wizardChoiceTheme(palette: HazeTheme) {
  return extendTheme(defaultTheme, {components: {Select: {styles: {
    container: () => ({flexDirection: 'column', width: '100%', overflow: 'hidden'}),
    option: () => ({height: 1, flexShrink: 0, width: '100%', overflow: 'hidden'}),
    label: ({isSelected}: {isSelected: boolean}) => ({
      color: isSelected ? palette.success : palette.muted, wrap: 'truncate-end',
    }),
    selectedIndicator: () => ({display: 'none'}),
  }}}});
}

/**
 * Select's public API has no controlled focus, filter, or Tab completion. Keep
 * one keyboard owner (the existing editor) and project its selected window into
 * a passive library Select. This preserves free-form escape paths and avoids
 * parallel listeners, private imports, and a second wizard state machine.
 */
export function WizardChoices({suggestions, activeIndex, rows}: {
  suggestions: TextInputSuggestion[];
  activeIndex: number;
  rows: number;
}) {
  const count = Math.max(0, Math.floor(rows));
  if (count === 0 || suggestions.length === 0) return null;
  const start = Math.max(0, activeIndex - Math.max(0, count - 1));
  const options = suggestions.slice(start, start + count).map((suggestion, index) => ({
    value: suggestion.value,
    label: safeInputDisplay(`${index + start === activeIndex ? '› ' : '  '}${suggestion.value} ${suggestion.kind ?? 'command'}${suggestion.description ? ` — ${suggestion.description}` : ''}`),
  }));
  return <ThemeProvider theme={wizardChoiceTheme(theme)}>
    <Select isDisabled options={options} visibleOptionCount={count}
      defaultValue={suggestions[activeIndex]?.value}
      key={`${start}:${count}:${suggestions[activeIndex]?.value}`} />
  </ThemeProvider>;
}
