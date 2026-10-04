import React from 'react';
import {expect, it, vi} from 'vitest';
import {TextInput} from '../../src/ui/components/TextInput.js';
import {inkHarness} from '../inkHarness.js';

it('parses terminal replies, keypad Enter, modified Enter and both interrupt encodings', async () => {
  const submit = vi.fn();
  const interrupt = vi.fn();
  const fixture = inkHarness(<TextInput onSubmit={submit} onInterrupt={interrupt} />);
  try {
    await fixture.app.waitUntilRenderFlush();
    fixture.stdin.write('\x1b[?0u\x1b[I\x1b[O\x1b[1;1R\x1b[<0;1;1M');
    fixture.stdin.write('hello');
    await expect.poll(() => fixture.stdout.writes.join('')).toContain('hello');
    fixture.stdin.write('\x1bOM');
    await expect.poll(() => submit.mock.calls).toEqual([['hello']]);
    fixture.stdin.write('one');
    await expect.poll(() => fixture.stdout.writes.join('')).toContain('one');
    fixture.stdin.write('\x1b[13;2u');
    await fixture.app.waitUntilRenderFlush();
    fixture.stdin.write('two');
    await expect.poll(() => fixture.stdout.writes.join('')).toContain('two');
    fixture.stdin.write('\r');
    await expect.poll(() => submit.mock.calls).toEqual([['hello'], ['one\ntwo']]);
    fixture.app.rerender(<TextInput disabled onSubmit={submit} onInterrupt={interrupt} />);
    await fixture.app.waitUntilRenderFlush();
    fixture.stdin.write('\x03');
    await expect.poll(() => interrupt.mock.calls.length).toBe(1);
    fixture.stdin.write('\x1b[99;5u');
    await expect.poll(() => interrupt.mock.calls.length).toBe(2);
  } finally {
    await fixture.close();
  }
  expect(fixture.stdin.isRaw).toBe(false);
  expect(fixture.stdin.listenerCount('readable')).toBe(0);
});

it('treats split/coalesced bracketed paste as data, including probes and shortcut bytes', async () => {
  const submit = vi.fn();
  const interrupt = vi.fn();
  const toggle = vi.fn();
  const resume = vi.fn();
  const fixture = inkHarness(<TextInput onSubmit={submit} onInterrupt={interrupt} onToggleTasks={toggle} onResumeKey={resume} />);
  const payload = '[?0u\r\n/exit\r\nR\r\n\x03\x0f';
  try {
    await fixture.app.waitUntilRenderFlush();
    fixture.stdin.write('\x1b[20');
    fixture.stdin.write('0~' + payload.slice(0, 8));
    fixture.stdin.write(payload.slice(8) + '\x1b[201~');
    await expect.poll(() => fixture.stdout.writes.join('')).toContain('[paste #1 +4 lines]');
    expect(submit).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    fixture.stdin.write('\r');
    await expect.poll(() => submit.mock.calls).toEqual([['[?0u\n/exit\nR\n\x03\x0f']]);
    fixture.stdin.write('\x1b[200~[?0u\x1b[201~');
    await expect.poll(() => fixture.stdout.writes.join('')).toContain('[?0u');
    fixture.stdin.write('\x02'); // Unsupported Ctrl+B must not type a b.
    // Separate physical reads: adjacent legacy text bytes are one unbracketed chunk.
    await new Promise<void>(resolve => setImmediate(resolve));
    fixture.stdin.write('\r');
    await expect.poll(() => submit.mock.calls[1]).toEqual(['[?0u']);
    fixture.app.rerender(<TextInput disabled onSubmit={submit} onInterrupt={interrupt} />);
    await fixture.app.waitUntilRenderFlush();
    fixture.stdin.write('\x1b[200~/exit\r\x03\x1b[201~');
    await fixture.app.waitUntilRenderFlush();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(interrupt).not.toHaveBeenCalled();
  } finally { await fixture.close(); }
});

it.each(['界', '🙂', 'e\u0301', '👨‍👩‍👧‍👦'])('edits complete graphemes through real input: %s', async text => {
  const submit = vi.fn();
  const fixture = inkHarness(<TextInput onSubmit={submit} />);
  try {
    await fixture.app.waitUntilRenderFlush();
    fixture.stdin.write(`\x1b[200~a${text}z\x1b[201~`);
    await expect.poll(() => fixture.stdout.writes.join('')).toContain(text);
    fixture.stdin.write('\x1b[D');
    await fixture.app.waitUntilRenderFlush();
    fixture.stdin.write('\x7f');
    await fixture.app.waitUntilRenderFlush();
    fixture.stdin.write('\r');
    await expect.poll(() => submit.mock.calls).toEqual([['az']]);
  } finally { await fixture.close(); }
});

it('keeps masked Unicode/paste content out of display and history', async () => {
  const submit = vi.fn();
  const history = vi.fn();
  const fixture = inkHarness(<TextInput mask recordHistory={false} onHistoryAdd={history} onSubmit={submit} />);
  try {
    await fixture.app.waitUntilRenderFlush();
    fixture.stdin.write('\x1b[200~界🙂e\u0301\x1b[201~');
    await expect.poll(() => fixture.stdout.writes.join('')).toContain('•••');
    fixture.stdin.write('\r');
    await expect.poll(() => submit.mock.calls).toEqual([['界🙂e\u0301']]);
    expect(fixture.stdout.writes.join('')).not.toContain('界');
    expect(history).not.toHaveBeenCalled();
  } finally { await fixture.close(); }
});
