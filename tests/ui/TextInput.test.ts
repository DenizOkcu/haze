import {describe, expect, it} from 'vitest';
import {isInterruptInput, isKittyQueryResponseInput, shouldInsertNewline} from '../../src/ui/components/TextInput.js';

describe('TextInput keyboard helpers', () => {
  it('treats explicit ctrl/shift/alt return as newline insertion', () => {
    expect(shouldInsertNewline('', {return: true, ctrl: true})).toBe(true);
    expect(shouldInsertNewline('', {return: true, shift: true})).toBe(true);
    // Alt/Option+Enter (legacy ESC+\r and kitty CSI 13;3u) both parse to
    // return+meta, and must insert a newline rather than submit.
    expect(shouldInsertNewline('', {return: true, meta: true})).toBe(true);
    expect(shouldInsertNewline('', {return: true, shift: true, ctrl: true})).toBe(true);
  });

  it('treats macOS Ctrl+Enter LF input as newline insertion', () => {
    expect(shouldInsertNewline('\n', {})).toBe(true);
  });

  it('treats common enhanced keyboard Enter escapes as newline insertion', () => {
    expect(shouldInsertNewline('\u001B[13;2u', {})).toBe(true);
    expect(shouldInsertNewline('\u001B[13;2~', {})).toBe(true);
    expect(shouldInsertNewline('\u001B[13;5u', {})).toBe(true);
    expect(shouldInsertNewline('\u001B[13;5~', {})).toBe(true);
  });

  it('does not treat plain return as newline insertion', () => {
    expect(shouldInsertNewline('', {return: true})).toBe(false);
  });

  it('recognizes Ctrl+C in both legacy and kitty encodings', () => {
    // Legacy \x03 and kitty CSI 99;5u both parse to `c` + ctrl in Ink.
    expect(isInterruptInput('c', {ctrl: true})).toBe(true);
    expect(isInterruptInput('\x03', {})).toBe(true);
    // Plain typing and other modifiers must not terminate.
    expect(isInterruptInput('c', {})).toBe(false);
    expect(isInterruptInput('c', {shift: true})).toBe(false);
    expect(isInterruptInput('a', {ctrl: true})).toBe(false);
  });

  it('drops kitty protocol probe responses racing the input pipeline', () => {
    // The leading ESC is stripped by Ink before the input reaches TextInput;
    // accept both forms defensively.
    expect(isKittyQueryResponseInput('[?0u')).toBe(true);
    expect(isKittyQueryResponseInput('[?1u')).toBe(true);
    expect(isKittyQueryResponseInput('[?65u')).toBe(true);
    expect(isKittyQueryResponseInput('[?0;1u')).toBe(true);
    expect(isKittyQueryResponseInput('\u001B[?0u')).toBe(true);
    // User-typed or pasted text, key sequences, and malformed probes pass through.
    expect(isKittyQueryResponseInput('?0u')).toBe(false);
    expect(isKittyQueryResponseInput('[?u')).toBe(false);
    expect(isKittyQueryResponseInput('[?0v')).toBe(false);
    expect(isKittyQueryResponseInput('[13;5u')).toBe(false);
    expect(isKittyQueryResponseInput('hello')).toBe(false);
    expect(isKittyQueryResponseInput('')).toBe(false);
  });
});
