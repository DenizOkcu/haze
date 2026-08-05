import {EventEmitter} from 'node:events';
import {afterEach, describe, expect, it, vi} from 'vitest';

const {spawnMock} = vi.hoisted(() => ({spawnMock: vi.fn()}));
vi.mock('node:child_process', () => ({spawn: spawnMock}));

import {openPath} from '../../src/utils/openPath.js';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {unref: ReturnType<typeof vi.fn>};
  child.unref = vi.fn();
  return child;
}

afterEach(() => {
  spawnMock.mockReset();
});

describe('openPath', () => {
  it('resolves true after the platform opener spawns', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const opened = openPath('https://example.com');
    child.emit('spawn');
    await expect(opened).resolves.toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it('resolves false when the platform opener fails', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const opened = openPath('/missing/file');
    child.emit('error', new Error('not found'));
    await expect(opened).resolves.toBe(false);
  });

  it('selects the platform-correct opener command and args', async () => {
    const originalPlatform = process.platform;
    for (const scenario of [
      {platform: 'darwin', expectedCommand: 'open', expectedArgs: ['https://example.com']},
      {platform: 'linux', expectedCommand: 'xdg-open', expectedArgs: ['https://example.com']},
      {platform: 'win32', expectedCommand: 'cmd', expectedArgs: ['/c', 'start', '', 'https://example.com']},
    ] as const) {
      Object.defineProperty(process, 'platform', {value: scenario.platform, configurable: true});
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const opened = openPath('https://example.com');
      child.emit('spawn');
      await expect(opened).resolves.toBe(true);
      expect(spawnMock).toHaveBeenCalledWith(scenario.expectedCommand, scenario.expectedArgs, expect.anything());
      spawnMock.mockReset();
    }
    Object.defineProperty(process, 'platform', {value: originalPlatform, configurable: true});
  });

  it('forwards spawn errors to the optional onError callback', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const onError = vi.fn();
    const opened = openPath('https://example.com', onError);
    child.emit('error', new Error('xdg-open ENOENT'));
    await expect(opened).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({message: 'xdg-open ENOENT'}));
  });
});
