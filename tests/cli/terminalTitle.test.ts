import {afterEach, describe, expect, it, vi} from 'vitest';
import {installTerminalTitle, terminalTitleLabel} from '../../src/cli/terminalTitle.js';

describe('terminalTitleLabel', () => {
  it('formats haze plus the current directory basename', () => {
    expect(terminalTitleLabel('/Users/somebody/development/haze')).toBe('haze - haze');
  });

  it('falls back to plain haze when the path has no basename', () => {
    expect(terminalTitleLabel('/')).toBe('haze');
  });

  it('strips control characters from the directory name', () => {
    expect(terminalTitleLabel(`/tmp/weird\u0007dir\u001B`)).toBe('haze - weirddir');
  });
});

describe('installTerminalTitle', () => {
  const originalIsTTY = process.stdout.isTTY;

  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
    vi.restoreAllMocks();
  });

  it('is a no-op when stdout is not a TTY', () => {
    process.stdout.isTTY = false;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    installTerminalTitle('haze - haze');
    expect(write).not.toHaveBeenCalled();
  });

  it('writes the OSC title sequence when stdout is a TTY', () => {
    process.stdout.isTTY = true;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    installTerminalTitle('haze - haze');
    expect(write).toHaveBeenCalledWith('\u001B]0;haze - haze\u0007');
  });
});
