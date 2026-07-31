import {describe, expect, it} from 'vitest';
import {WorkspaceMutationPolicy} from '../../../src/core/subagent/workspaceMutationPolicy.js';

describe('WorkspaceMutationPolicy', () => {
  it('is reentrant for one owner and serializes another owner', async () => {
    const policy = new WorkspaceMutationPolicy();
    const first = policy.createOwner();
    const second = policy.createOwner();
    const releaseA = await policy.acquire(first);
    const releaseNested = await policy.acquire(first);
    let secondEntered = false;
    const waiting = policy.acquire(second).then(release => { secondEntered = true; return release; });
    await Promise.resolve();
    expect(secondEntered).toBe(false);
    releaseNested();
    await Promise.resolve();
    expect(secondEntered).toBe(false);
    releaseA();
    const releaseB = await waiting;
    expect(secondEntered).toBe(true);
    releaseB();
  });

  it('removes an aborted waiter and releases after errors via caller finally', async () => {
    const policy = new WorkspaceMutationPolicy();
    const release = await policy.acquire(policy.createOwner());
    const controller = new AbortController();
    const waiting = policy.acquire(policy.createOwner(), controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow(/cancelled/);
    release();
    const nextRelease = await policy.acquire(policy.createOwner());
    nextRelease();
  });
});
