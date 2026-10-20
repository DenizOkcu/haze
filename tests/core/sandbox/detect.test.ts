import {afterEach, describe, expect, it, vi} from 'vitest';
import {ChildProcess, type SpawnOptions} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {detectSandboxBackend, resetSandboxDetection, sandboxUnavailableRemedy} from '../../../src/core/sandbox/detect.js';

function fakeSpawn(result: {code?: number | null; error?: Error; stderr?: string}) {
  return vi.fn((_command: string, _args: readonly string[], _options?: SpawnOptions) => {
    const child = new EventEmitter() as ChildProcess;
    child.pid = 12345;
    Object.assign(child, {stderr: new EventEmitter(), kill: () => true});
    queueMicrotask(() => {
      if (result.stderr) child.stderr?.emit('data', Buffer.from(result.stderr, 'utf8'));
      if (result.error) child.emit('error', result.error);
      else child.emit('close', result.code ?? 0);
    });
    return child;
  });
}

afterEach(() => {
  resetSandboxDetection();
  vi.restoreAllMocks();
});

describe('detectSandboxBackend', () => {
  it('windows is unsupported without probing', async () => {
    const info = await detectSandboxBackend({platform: 'win32'});
    expect(info).toEqual({backend: 'none', reason: 'unsupported_platform', detail: expect.stringContaining('win32')});
  });

  it('a successful seatbelt probe reports seatbelt and caches', async () => {
    const spawnProcess = fakeSpawn({code: 0});
    const first = await detectSandboxBackend({platform: 'darwin', spawnProcess});
    expect(first).toEqual({backend: 'seatbelt'});
    await detectSandboxBackend({platform: 'darwin', spawnProcess});
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it('a missing sandbox-exec reports missing_binary', async () => {
    const info = await detectSandboxBackend({platform: 'darwin', spawnProcess: fakeSpawn({error: Object.assign(new Error('spawn /usr/bin/sandbox-exec ENOENT'), {code: 'ENOENT'})})});
    expect(info.backend).toBe('none');
    expect(info.reason).toBe('missing_binary');
  });

  it('a failing seatbelt probe reports probe_failed with bounded detail', async () => {
    const info = await detectSandboxBackend({platform: 'darwin', spawnProcess: fakeSpawn({code: 65, stderr: 'sandbox-exec: unbound variable: x at <input string>, line 1, column 13'})});
    expect(info.backend).toBe('none');
    expect(info.reason).toBe('probe_failed');
    expect(info.detail).toContain('unbound variable');
  });

  it('a successful bwrap probe reports bubblewrap', async () => {
    const info = await detectSandboxBackend({platform: 'linux', spawnProcess: fakeSpawn({code: 0})});
    expect(info).toEqual({backend: 'bubblewrap'});
  });

  it('missing bwrap reports missing_binary with an install hint', async () => {
    const info = await detectSandboxBackend({platform: 'linux', spawnProcess: fakeSpawn({error: Object.assign(new Error('spawn bwrap ENOENT'), {code: 'ENOENT'})})});
    expect(info.reason).toBe('missing_binary');
    expect(info.detail).toContain('bubblewrap');
  });

  it('user-namespace denial is classified', async () => {
    const info = await detectSandboxBackend({platform: 'linux', spawnProcess: fakeSpawn({code: 1, stderr: 'bwrap: Creating new namespace failed: Operation not permitted (user namespaces restricted)'})});
    expect(info.reason).toBe('userns_denied');
    expect(sandboxUnavailableRemedy(info)).toContain('user namespaces');
  });

  it('reset clears the cache', async () => {
    const spawnProcess = fakeSpawn({code: 0});
    await detectSandboxBackend({platform: 'darwin', spawnProcess});
    resetSandboxDetection();
    await detectSandboxBackend({platform: 'darwin', spawnProcess});
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });
});
