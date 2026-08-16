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
    expect(resolveUserShell()).toBe('/bin/bash');
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
