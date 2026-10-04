import React from 'react';
import {Select, TextInput as LibraryTextInput} from '@inkjs/ui';
import {render} from 'ink-testing-library';
import {expect, it, vi} from 'vitest';
import {TextInput} from '../../src/ui/components/TextInput.js';
import {WizardChoices, wizardChoiceTheme} from '../../src/ui/components/WizardChoices.js';
import {resolveTheme} from '../../src/ui/theme.js';
import {themeSuggestions} from '../../src/cli/commands/wizardFlow.js';
import {inkHarness} from '../inkHarness.js';
import {DynamicFrame} from '../../src/cli/chat/DynamicFrame.js';

it('mounts and unmounts published input and Select with the real Ink renderer', async () => {
  for (const node of [<LibraryTextInput />, <Select options={[{value: 'a', label: 'A'}]} />]) {
    const fixture = inkHarness(node);
    await fixture.app.waitUntilRenderFlush();
    await fixture.close();
    expect(fixture.stdin.isRaw).toBe(false);
    expect(fixture.stdin.listenerCount('readable')).toBe(0);
  }
});

it('themes pilot preserves filtering, Tab, single submit, cancellation, and no history', async () => {
  const submit = vi.fn();
  const escape = vi.fn();
  const history = vi.fn();
  const toggle = vi.fn();
  const fixture = inkHarness(<TextInput suggestionMode="always"
    suggestions={themeSuggestions({})} recordHistory={false} onHistoryAdd={history}
    onToggleTasks={toggle} onEscape={escape} onSubmit={submit} />);
  try {
    await fixture.app.waitUntilRenderFlush();
    fixture.stdout.writes.length = 0;
    fixture.stdin.write('purp');
    await expect.poll(() => fixture.stdout.writes.join('')).toContain('› purp');
    fixture.stdin.write('\t');
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    await fixture.app.waitUntilRenderFlush();
    fixture.stdin.write('\r');
    await expect.poll(() => submit.mock.calls).toEqual([['purple']]);
    fixture.stdin.write('\x0f');
    await expect.poll(() => toggle.mock.calls.length).toBe(1);
    fixture.stdin.write('\x1b');
    await expect.poll(() => escape.mock.calls.length).toBe(1);
    expect(history).not.toHaveBeenCalled();
  } finally { await fixture.close(); }
});

it('keeps the selected choice visible on resize and safely handles empty/zero rows', async () => {
  const suggestions = Array.from({length: 20}, (_, index) => ({value: `choice-${index}`, description: '界'.repeat(100)}));
  const app = render(<WizardChoices suggestions={suggestions} activeIndex={12} rows={5} />);
  try {
    await expect.poll(() => app.lastFrame()).toContain('› choice-12');
    expect(app.lastFrame()?.split('\n')).toHaveLength(5);
    app.rerender(<WizardChoices suggestions={suggestions} activeIndex={12} rows={1} />);
    await expect.poll(() => app.lastFrame()?.split('\n').length).toBe(1);
    expect(app.lastFrame()).toContain('› choice-12');
    app.rerender(<WizardChoices suggestions={suggestions} activeIndex={12} rows={0} />);
    await expect.poll(() => app.lastFrame()).toBe('');
    app.rerender(<WizardChoices suggestions={[]} activeIndex={0} rows={5} />);
    await expect.poll(() => app.lastFrame()).toBe('');
  } finally { app.unmount(); app.cleanup(); }
});

it('maps each live palette instead of retaining default library colors', () => {
  for (const name of ['purple', 'robbyrussell']) {
    const palette = resolveTheme(name);
    const styles = wizardChoiceTheme(palette).components.Select!.styles!;
    expect(styles.label!({isSelected: true})).toEqual({color: palette.success, wrap: 'truncate-end'});
    expect(styles.label!({isSelected: false})).toEqual({color: palette.muted, wrap: 'truncate-end'});
  }
});

it('navigates library-backed choices once, preserves stable identity, and returns to multiline chat', async () => {
  const submit = vi.fn();
  const suggestions = [
    {value: 'review · project', description: 'Same label · project', kind: 'skill' as const},
    {value: 'review · global', description: 'Same label · global', kind: 'skill' as const},
  ];
  const fixture = inkHarness(<TextInput suggestionMode="always" suggestions={suggestions}
    recordHistory={false} onSubmit={submit} />);
  try {
    await fixture.app.waitUntilRenderFlush();
    fixture.stdin.write('\x1b[B');
    await expect.poll(() => fixture.stdout.writes.join('')).toContain('› review · global');
    fixture.stdin.write('\r');
    await expect.poll(() => submit.mock.calls).toEqual([['review · global']]);
    fixture.app.rerender(<TextInput onSubmit={submit} />);
    await fixture.app.waitUntilRenderFlush();
    fixture.stdin.write('\x1b[200~one\ntwo\x1b[201~');
    await expect.poll(() => fixture.stdout.writes.join('')).toContain('two');
    expect(submit).toHaveBeenCalledTimes(1);
    fixture.stdin.write('\r');
    await expect.poll(() => submit.mock.calls).toEqual([['review · global'], ['one\ntwo']]);
    fixture.app.rerender(<TextInput suggestionMode="always" suggestions={suggestions}
      recordHistory={false} onSubmit={submit} />);
    await fixture.app.waitUntilRenderFlush();
    fixture.stdin.write('\r');
    await expect.poll(() => submit.mock.calls[2]).toEqual(['review · project']);
  } finally { await fixture.close(); }
});

it('discards disabled picker paste, retains Ctrl+C, and accepts unmatched manual values', async () => {
  const submit = vi.fn();
  const interrupt = vi.fn();
  const suggestions = [{value: 'known'}];
  const fixture = inkHarness(<TextInput disabled suggestionMode="always" suggestions={suggestions}
    onSubmit={submit} onInterrupt={interrupt} />);
  try {
    await fixture.app.waitUntilRenderFlush();
    fixture.stdin.write('\x1b[200~/exit\r\x03\x1b[201~');
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    expect(submit).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    fixture.stdin.write('\x03');
    await expect.poll(() => interrupt.mock.calls.length).toBe(1);
    fixture.app.rerender(<TextInput suggestionMode="always" suggestions={suggestions}
      onSubmit={submit} onInterrupt={interrupt} recordHistory={false} />);
    await fixture.app.waitUntilRenderFlush();
    fixture.stdin.write('\x1b[200~manual\nmodel\x1b[201~');
    await expect.poll(() => fixture.stdout.writes.join('')).toContain('model');
    expect(submit).not.toHaveBeenCalled();
    fixture.stdin.write('\r');
    await expect.poll(() => submit.mock.calls).toEqual([['manual\nmodel']]);
  } finally { await fixture.close(); }
});

it.each([[80, 24], [16, 8], [4, 3], [1, 1]])('bounds the entire picker frame at %s columns / %s rows', async (columns, rows) => {
  const app = render(<DynamicFrame columns={columns} rows={rows} sections={{}}
    input={limits => <TextInput {...limits} suggestionMode="always"
      suggestions={themeSuggestions({})} onSubmit={() => {}} />} />);
  try {
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    const frame = app.lastFrame() ?? '';
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    for (const line of frame.split('\n')) expect([...line].length).toBeLessThanOrEqual(columns);
  } finally { app.unmount(); app.cleanup(); }
});
