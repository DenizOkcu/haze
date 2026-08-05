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
});
