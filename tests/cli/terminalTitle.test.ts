import {afterEach, describe, expect, it, vi} from 'vitest';
import {installTerminalTitle, terminalTitleLabel} from '../../src/cli/terminalTitle.js';

describe('terminalTitleLabel', () => {
  it('formats haze plus the current directory basename', () => {
    expect(terminalTitleLabel('/Users/somebody/development/haze')).toBe('haze - haze');
  });

  it('falls back to plain haze when the path has no basename', () => {
    expect(terminalTitleLabel('/')).toBe('haze');
  });

  it('strips C0 and C1 control characters from the directory name', () => {
    expect(terminalTitleLabel(`/tmp/weird\u0007dir\u001B\u009Bunsafe\u009C`)).toBe('haze - weirddirunsafe');
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

  it('writes the OSC title in both BEL- and ST-terminated forms when stdout is a TTY', () => {
    process.stdout.isTTY = true;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    installTerminalTitle('haze - haze');
    expect(write).toHaveBeenCalledWith('\u001B]0;haze - haze\u0007\u001B]0;haze - haze\u001B\\');
  });

  it('restores the title on exit and on the fatal-path monitor hooks (FE-12)', () => {
    process.stdout.isTTY = true;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitListeners: (() => void)[] = [];
    const monitorListeners: (() => void)[] = [];
    const rejectionListeners: (() => void)[] = [];
    const onceSpy = vi.spyOn(process, 'once').mockImplementation((event, listener) => {
      if (event === 'exit') exitListeners.push(listener as () => void);
      return process;
    });
    const onSpy = vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'uncaughtExceptionMonitor') monitorListeners.push(listener as () => void);
      if (event === 'unhandledRejection') rejectionListeners.push(listener as () => void);
      return process;
    });
    installTerminalTitle('haze - haze');
    expect(exitListeners.length).toBe(1);
    expect(monitorListeners.length).toBe(1);
    expect(rejectionListeners.length).toBe(1);
    write.mockClear();
    exitListeners[0]!();
    monitorListeners[0]!();
    rejectionListeners[0]!();
    expect(write).toHaveBeenCalledWith('\u001B]0;\u0007\u001B]0;\u001B\\');
    expect(write).toHaveBeenCalledTimes(3);
    onceSpy.mockRestore();
    onSpy.mockRestore();
  });
});
