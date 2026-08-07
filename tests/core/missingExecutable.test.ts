import {describe, expect, it} from 'vitest';
import {detectMissingExecutable, missingExecutableFields} from '../../src/core/safety/missingExecutable.js';

describe('detectMissingExecutable', () => {
  it('detects a bash "command not found" and derives the executable name', () => {
    const d = detectMissingExecutable({command: 'ruff check .', code: 127, stderr: 'bash: ruff: command not found\n'});
    expect(d?.executable).toBe('ruff');
    expect(d?.suggestedNextStep).toContain('ruff');
    expect(d?.suggestedNextStep).toMatch(/alternative.*manifest.*consent|consent.*manifest.*alternative/s);
  });

  it('detects a zsh "command not found" form', () => {
    const d = detectMissingExecutable({command: 'mlint src', code: 127, stderr: 'zsh:1: command not found: mlint\n'});
    expect(d?.executable).toBe('mlint');
  });

  it('falls back to the command first token when only exit 127 is known', () => {
    const d = detectMissingExecutable({command: 'weirdtool --flag x', code: 127, stderr: ''});
    expect(d?.executable).toBe('weirdtool');
  });

  it('strips env/sudo wrappers when deriving the first token', () => {
    const d = detectMissingExecutable({command: 'env FOO=1 customrunner build', code: 127, stderr: ''});
    expect(d?.executable).toBe('customrunner');
  });

  it('is dependency-agnostic: no special-cased names, only generic guidance', () => {
    const d = detectMissingExecutable({command: 'whatever', code: 127, stderr: 'whatever: command not found'});
    expect(d).toBeDefined();
    // Guidance never hard-codes a specific dependency or installer.
    const step = d!.suggestedNextStep.toLowerCase();
    expect(step).not.toMatch(/\bapt-get\b|\bbrew install python\b|\bdocker pull\b/);
  });

  it('returns undefined for non-missing failures', () => {
    expect(detectMissingExecutable({command: 'npm test', code: 1, stderr: 'AssertionError'})).toBeUndefined();
    expect(detectMissingExecutable({command: 'echo hi', code: 0, stderr: ''})).toBeUndefined();
  });

  it('never exposes raw stderr or the full command in its bounded fields', () => {
    const secret = 'SUPERSECRET_TOKEN_VALUE';
    const d = detectMissingExecutable({command: 'mybin --opt', code: 127, stderr: `mybin: command not found\n${secret}`});
    const json = JSON.stringify({...d, ...missingExecutableFields(d!)});
    expect(json).not.toContain(secret);
    expect(json).not.toContain('--opt');
    expect(missingExecutableFields(d!)).toEqual({reasonCode: 'missing_executable', missingExecutable: 'mybin'});
  });
});
