import {describe, it, expect} from 'vitest';
import {checkForUpdate} from '../../src/config/updateCheck.js';
import type {UpdateCheckStore} from '../../src/config/updateCheck.js';

function makeFns() {
  const written: Array<{file: string; store: UpdateCheckStore}> = [];
  let store: UpdateCheckStore = {};
  const readStoreFn = async () => ({...store});
  const writeStoreFn = async (file: string, next: UpdateCheckStore) => {
    store = {...next};
    written.push({file, store: {...next}});
  };
  return {readStoreFn, writeStoreFn, getStore: () => store, written, setStore: (next: UpdateCheckStore) => {store = {...next};}};
}

describe('checkForUpdate', () => {
  it('returns isOutdated true when registry version is newer', async () => {
    const fns = makeFns();
    let spawned = 0;
    const result = await checkForUpdate({
      currentVersion: '0.6.0',
      packageName: '@denizokcu/haze',
      now: 1000,
      storePath: '/tmp/store.json',
      exec: async () => {spawned++; return '0.7.0\n';},
      ...fns,
    });
    expect(spawned).toBe(1);
    expect(result).toEqual({latestVersion: '0.7.0', isOutdated: true, checkedAt: 1000});
  });

  it('returns isOutdated false when versions are equal', async () => {
    const fns = makeFns();
    const result = await checkForUpdate({
      currentVersion: '0.6.0',
      packageName: '@denizokcu/haze',
      now: 1000,
      exec: async () => '0.6.0',
      ...fns,
    });
    expect(result?.isOutdated).toBe(false);
  });

  it('returns isOutdated false when registry version is older', async () => {
    const fns = makeFns();
    const result = await checkForUpdate({
      currentVersion: '0.6.0',
      packageName: '@denizokcu/haze',
      now: 1000,
      exec: async () => '0.5.9',
      ...fns,
    });
    expect(result?.isOutdated).toBe(false);
  });

  it('writes checkedAt and latestVersion to the store after a fresh check', async () => {
    const fns = makeFns();
    await checkForUpdate({
      currentVersion: '0.6.0',
      packageName: '@denizokcu/haze',
      now: 5000,
      storePath: '/tmp/store.json',
      exec: async () => '0.7.0',
      ...fns,
    });
    expect(fns.getStore()).toEqual({checkedAt: 5000, latestVersion: '0.7.0'});
    expect(fns.written[0]?.file).toBe('/tmp/store.json');
  });

  it('does not spawn npm within the throttle window and reuses cached version', async () => {
    const fns = makeFns();
    fns.setStore({checkedAt: 1000, latestVersion: '0.7.0'});
    let spawned = 0;
    const result = await checkForUpdate({
      currentVersion: '0.6.0',
      packageName: '@denizokcu/haze',
      now: 1000 + 1000, // 1s later, well within 24h
      intervalMs: 60_000,
      exec: async () => {spawned++; return '0.8.0';},
      ...fns,
    });
    expect(spawned).toBe(0);
    expect(result).toEqual({latestVersion: '0.7.0', isOutdated: true, checkedAt: 1000});
  });

  it('spawns npm again after the throttle window elapses', async () => {
    const fns = makeFns();
    fns.setStore({checkedAt: 1000, latestVersion: '0.6.0'});
    let spawned = 0;
    const result = await checkForUpdate({
      currentVersion: '0.6.0',
      packageName: '@denizokcu/haze',
      now: 1000 + 60_000 + 1, // just past the window
      intervalMs: 60_000,
      exec: async () => {spawned++; return '0.7.0';},
      ...fns,
    });
    expect(spawned).toBe(1);
    expect(result?.latestVersion).toBe('0.7.0');
    expect(fns.getStore().latestVersion).toBe('0.7.0');
  });

  it('recompares cached version against currentVersion without spawning', async () => {
    const fns = makeFns();
    // Cached latest is 0.7.0; user has since updated to 0.7.0.
    fns.setStore({checkedAt: 1000, latestVersion: '0.7.0'});
    let spawned = 0;
    const result = await checkForUpdate({
      currentVersion: '0.7.0',
      packageName: '@denizokcu/haze',
      now: 2000,
      intervalMs: 60_000,
      exec: async () => {spawned++; return '0.7.0';},
      ...fns,
    });
    expect(spawned).toBe(0);
    expect(result?.isOutdated).toBe(false);
  });

  it('returns undefined when npm exec rejects (offline / no npm)', async () => {
    const fns = makeFns();
    const result = await checkForUpdate({
      currentVersion: '0.6.0',
      packageName: '@denizokcu/haze',
      now: 1000,
      exec: async () => {throw new Error('spawn npm ENOENT');},
      ...fns,
    });
    expect(result).toBeUndefined();
    // A failed check must not corrupt or overwrite the store.
    expect(fns.written).toHaveLength(0);
  });

  it('returns undefined when npm returns empty output', async () => {
    const fns = makeFns();
    const result = await checkForUpdate({
      currentVersion: '0.6.0',
      packageName: '@denizokcu/haze',
      now: 1000,
      exec: async () => '   \n  ',
      ...fns,
    });
    expect(result).toBeUndefined();
  });

  it('takes only the first line of npm output', async () => {
    const fns = makeFns();
    const result = await checkForUpdate({
      currentVersion: '0.6.0',
      packageName: '@denizokcu/haze',
      now: 1000,
      exec: async () => '0.7.0\nnpm notice something\n',
      ...fns,
    });
    expect(result?.latestVersion).toBe('0.7.0');
  });

  it('handles a store read failure by falling back to a fresh check', async () => {
    let spawned = 0;
    const result = await checkForUpdate({
      currentVersion: '0.6.0',
      packageName: '@denizokcu/haze',
      now: 1000,
      storePath: '/tmp/store.json',
      exec: async () => {spawned++; return '0.7.0';},
      readStoreFn: async () => {throw new Error('corrupt');},
      writeStoreFn: async () => undefined,
    });
    expect(spawned).toBe(1);
    expect(result?.isOutdated).toBe(true);
  });

  it('still returns a result when the store write fails', async () => {
    let spawned = 0;
    const result = await checkForUpdate({
      currentVersion: '0.6.0',
      packageName: '@denizokcu/haze',
      now: 1000,
      exec: async () => {spawned++; return '0.7.0';},
      readStoreFn: async () => ({}),
      writeStoreFn: async () => {throw new Error('disk full');},
    });
    expect(spawned).toBe(1);
    expect(result?.isOutdated).toBe(true);
  });

  it('simulates a timeout by rejecting from exec', async () => {
    const fns = makeFns();
    const result = await checkForUpdate({
      currentVersion: '0.6.0',
      packageName: '@denizokcu/haze',
      now: 1000,
      timeoutMs: 5,
      exec: async () => {throw new Error('Timed out after 5ms');},
      ...fns,
    });
    expect(result).toBeUndefined();
  });
});
