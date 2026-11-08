import {afterEach, describe, expect, it, vi} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolveUserShell, shellDialect, shellInvocation, shellSyntaxGuidance} from '../../src/core/process/userShell.js';

const run = promisify(execFile);

describe('user shell resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses $SHELL when set', () => {
    vi.stubEnv('SHELL', '/bin/zsh');
    expect(resolveUserShell()).toBe('/bin/zsh');
  });

  it('uses an explicit HAZE_SHELL override for deterministic automation', () => {
    vi.stubEnv('SHELL', '/usr/local/bin/fish');
    vi.stubEnv('HAZE_SHELL', '/bin/bash');
    expect(resolveUserShell()).toBe('/bin/bash');
  });

  it('falls back to /bin/bash without $SHELL', () => {
    vi.stubEnv('HAZE_SHELL', '');
    vi.stubEnv('SHELL', '');
    expect(resolveUserShell({platform: 'linux'})).toBe('/bin/bash');
  });
});

describe('windows shell fallback', () => {
  const winEnv = (overrides: Record<string, string> = {}) => ({
    PATH: 'C:/Program Files/PowerShell/7;C:/Windows/System32;C:/Program Files/Git/bin',
    ComSpec: 'C:/Windows/System32/cmd.exe',
    ...overrides,
  });

  it('prefers pwsh when it is on PATH', () => {
    const pathExists = (candidate: string) => candidate === 'C:/Program Files/PowerShell/7/pwsh.exe';
    expect(resolveUserShell({platform: 'win32', env: winEnv(), pathExists})).toBe('C:/Program Files/PowerShell/7/pwsh.exe');
  });

  it('falls back to Git Bash when pwsh is absent', () => {
    const pathExists = (candidate: string) => candidate === 'C:/Program Files/Git/bin/bash.exe';
    expect(resolveUserShell({platform: 'win32', env: winEnv(), pathExists})).toBe('C:/Program Files/Git/bin/bash.exe');
  });

  it('honors PATHEXT when probing', () => {
    const pathExists = (candidate: string) => candidate === 'C:/Windows/System32/pwsh.EXE';
    const env = winEnv({PATHEXT: '.EXE', PATH: 'C:/Windows/System32'});
    expect(resolveUserShell({platform: 'win32', env, pathExists})).toBe('C:/Windows/System32/pwsh.EXE');
  });

  it('falls back to ComSpec, then cmd.exe, when no preferred shell is found', () => {
    const pathExists = () => false;
    expect(resolveUserShell({platform: 'win32', env: winEnv(), pathExists})).toBe('C:/Windows/System32/cmd.exe');
    expect(resolveUserShell({platform: 'win32', env: winEnv({ComSpec: ''}), pathExists})).toBe('cmd.exe');
  });

  it('still honors HAZE_SHELL and SHELL on Windows', () => {
    const pathExists = () => false;
    expect(resolveUserShell({platform: 'win32', env: winEnv({HAZE_SHELL: 'C:/tools/nu.exe'}), pathExists})).toBe('C:/tools/nu.exe');
    expect(resolveUserShell({platform: 'win32', env: winEnv({SHELL: 'C:/Program Files/Git/bin/bash.exe'}), pathExists})).toBe('C:/Program Files/Git/bin/bash.exe');
  });
});

describe('shell dialect guidance', () => {
  it('identifies supported syntax families', () => {
    expect(shellDialect('/bin/zsh')).toBe('posix');
    expect(shellDialect('/usr/local/bin/fish')).toBe('fish');
    expect(shellDialect('/bin/tcsh')).toBe('csh');
    expect(shellDialect('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('powershell');
    expect(shellDialect('C:\\Windows\\System32\\cmd.exe')).toBe('cmd');
  });

  it('warns non-POSIX shells not to use POSIX assignment syntax', () => {
    expect(shellSyntaxGuidance('/bin/tcsh')).toContain('do not use POSIX variable-assignment syntax');
    expect(shellSyntaxGuidance('/usr/local/bin/fish')).toContain('do not use POSIX variable-assignment syntax');
  });
});

describe('shell invocation flags', () => {
  it('passes -l -c to login-capable shells', () => {
    expect(shellInvocation('echo hi', '/bin/zsh')).toEqual({command: '/bin/zsh', args: ['-l', '-c', 'echo hi']});
    expect(shellInvocation('echo hi', '/usr/local/bin/fish')).toEqual({command: '/usr/local/bin/fish', args: ['-l', '-c', 'echo hi']});
  });

  it('passes plain -c to shells without a login flag', () => {
    expect(shellInvocation('echo hi', '/bin/sh')).toEqual({command: '/bin/sh', args: ['-c', 'echo hi']});
    expect(shellInvocation('echo hi', '/usr/bin/dash')).toEqual({command: '/usr/bin/dash', args: ['-c', 'echo hi']});
    expect(shellInvocation('echo hi', '/opt/mystery')).toEqual({command: '/opt/mystery', args: ['-c', 'echo hi']});
  });

  it('uses the native flag style for PowerShell and cmd', () => {
    expect(shellInvocation('echo hi', '/usr/local/bin/pwsh')).toEqual({command: '/usr/local/bin/pwsh', args: ['-Command', 'echo hi']});
    expect(shellInvocation('echo hi', 'C:\\Windows\\System32\\cmd.exe')).toEqual({command: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'echo hi']});
  });

  it('runs a command under the resolved user shell', async () => {
    const {command, args} = shellInvocation('printf ok');
    const {stdout} = await run(command, args);
    expect(stdout).toBe('ok');
  });
});
