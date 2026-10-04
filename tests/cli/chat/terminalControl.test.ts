import {describe, expect, it} from 'vitest';
import {resolveEditorCommand, resolvePager, runSuspendedChild} from '../../../src/cli/chat/terminalControl.js';

describe('resolveEditorCommand', () => {
  it('returns false without an editor configured', () => {
    expect(resolveEditorCommand({})).toBe(false);
    expect(resolveEditorCommand({EDITOR: '  '})).toBe(false);
  });

  it('prefers VISUAL over EDITOR', () => {
    expect(resolveEditorCommand({VISUAL: 'vim', EDITOR: 'nano'})).toEqual({command: 'vim', args: []});
  });

  it('splits composite editor values into args', () => {
    expect(resolveEditorCommand({EDITOR: 'code -w'})).toEqual({command: 'code', args: ['-w']});
    expect(resolveEditorCommand({EDITOR: 'vim -f'})).toEqual({command: 'vim', args: ['-f']});
  });

  it('unquotes a single quoted editor command', () => {
    expect(resolveEditorCommand({EDITOR: '"my editor" -w'})).toEqual({command: 'my editor', args: ['-w']});
  });
});

describe('resolvePager', () => {
  it('returns undefined when the text fits one screen', () => {
    expect(resolvePager('one\ntwo\nthree', 10)).toBeUndefined();
  });

  it('resolves less with color/init flags by default', () => {
    const pager = resolvePager(Array.from({length: 100}, (_, i) => `line ${i}`).join('\n'), 10, {});
    expect(pager?.command).toBe('less');
    expect(pager?.args).toEqual(['-R', '-X']);
  });

  it.each([
    ['less -R', {command: 'less', args: ['-R']}],
    ['less -S -R', {command: 'less', args: ['-S', '-R']}],
    ['"my pager" --label "two words"', {command: 'my pager', args: ['--label', 'two words']}],
  ])('splits pager executable and arguments: %s', (pager, expected) => {
    expect(resolvePager('a\n'.repeat(50), 10, {PAGER: pager})).toEqual(expected);
  });

  it('honours $PAGER when set', () => {
    const pager = resolvePager('a\n'.repeat(50), 10, {PAGER: 'bat --paging=always'});
    expect(pager?.command).toBe('bat');
    expect(pager?.args).toEqual(['--paging=always']);
  });
});

describe('runSuspendedChild', () => {
  it('survives a pager quitting before consuming a large pending write', async () => {
    await expect(runSuspendedChild({command: process.execPath, args: ['-e', 'process.exit(0)']}, 'x'.repeat(10_000_000))).resolves.toBe(0);
  });

  it('passes quoted arguments to a real pager executable', async () => {
    const pager = resolvePager('a\n'.repeat(50), 10, {
      PAGER: `"${process.execPath}" -e 'process.exit(process.argv[1] === "two words" ? 0 : 1)' 'two words'`,
    });
    expect(pager).toBeDefined();
    await expect(runSuspendedChild(pager!, 'a\n'.repeat(50))).resolves.toBe(0);
  });

  it('rejects a spawn failure without an unhandled input-stream error', async () => {
    await expect(runSuspendedChild({command: 'haze-test-nonexistent-pager', args: []}, 'x'.repeat(1_000_000))).rejects.toMatchObject({code: 'ENOENT'});
  });
});
