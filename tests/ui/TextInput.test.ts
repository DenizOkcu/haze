import {describe, expect, it} from 'vitest';
import {shouldInsertNewline} from '../../src/ui/components/TextInput.js';

describe('TextInput keyboard helpers', () => {
  it('treats explicit ctrl/shift return as newline insertion', () => {
    expect(shouldInsertNewline('', {return: true, ctrl: true})).toBe(true);
    expect(shouldInsertNewline('', {return: true, shift: true})).toBe(true);
  });

  it('treats macOS Ctrl+Enter LF input as newline insertion', () => {
    expect(shouldInsertNewline('\n', {})).toBe(true);
  });

  it('treats common enhanced keyboard Ctrl+Enter escapes as newline insertion', () => {
    expect(shouldInsertNewline('\u001B[13;5u', {})).toBe(true);
    expect(shouldInsertNewline('\u001B[13;5~', {})).toBe(true);
  });

  it('does not treat plain return as newline insertion', () => {
    expect(shouldInsertNewline('', {return: true})).toBe(false);
  });
});
