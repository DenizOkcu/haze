import {describe, expect, it} from 'vitest';
import {resolveEditorCommand, resolvePager} from '../../../src/cli/chat/terminalControl.js';

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

  it('honours $PAGER when set', () => {
    const pager = resolvePager('a\n'.repeat(50), 10, {PAGER: 'bat --paging=always'});
    expect(pager?.command).toBe('bat --paging=always');
    expect(pager?.args).toEqual([]);
  });
});
