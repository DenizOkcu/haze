import {describe, expect, it} from 'vitest';
import {SubagentCoordinator} from '../../../src/core/subagent/subagentCoordinator.js';
import {COMPATIBILITY_PROFILE} from '../../../src/core/subagent/executionProfiles.js';
import {WorkspaceMutationPolicy} from '../../../src/core/subagent/workspaceMutationPolicy.js';
import type {WorkerTermination} from '../../../src/core/subagent/contracts.js';

type Result = {termination: WorkerTermination; id: string};
const terminal = (id: string) => (termination: 'cancelled' | 'deadline_exceeded'): Result => ({id, termination});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

describe('SubagentCoordinator', () => {
  it('hard-bounds global concurrency and gives every task one terminal event', async () => {
    const profile = {...COMPATIBILITY_PROFILE, maxConcurrency: 2};
    const events: string[] = [];
    const coordinator = new SubagentCoordinator(profile, event => { if (event.type === 'terminal') events.push(event.id); });
    let active = 0;
    let peak = 0;
    const gates = Array.from({length: 4}, deferred);
    const jobs = gates.map((gate, index) => coordinator.submit<Result>({
      id: `w${index}`, mode: 'inspect',
      run: async () => { active++; peak = Math.max(peak, active); await gate.promise; active--; return {id: `w${index}`, termination: 'completed'}; },
      terminal: terminal(`w${index}`), terminationOf: value => value.termination,
    }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(peak).toBe(2);
    gates[0]!.resolve(); gates[1]!.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(peak).toBe(2);
    gates[2]!.resolve(); gates[3]!.resolve();
    await expect(Promise.all(jobs)).resolves.toHaveLength(4);
    expect(new Set(events).size).toBe(4);
    expect(coordinator.peakConcurrency).toBe(2);
  });

  it('serializes mutation modes and admits implement before same-batch validate', async () => {
    const coordinator = new SubagentCoordinator({...COMPATIBILITY_PROFILE, maxConcurrency: 3});
    const order: string[] = [];
    const gate = deferred();
    const validate = coordinator.submit<Result>({id: 'validate', mode: 'validate', run: async () => { order.push('validate'); return {id: 'validate', termination: 'completed'}; }, terminal: terminal('validate'), terminationOf: result => result.termination});
    const implement = coordinator.submit<Result>({id: 'implement', mode: 'implement', run: async () => { order.push('implement'); await gate.promise; return {id: 'implement', termination: 'completed'}; }, terminal: terminal('implement'), terminationOf: result => result.termination});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(order).toEqual(['implement']);
    gate.resolve();
    await Promise.all([implement, validate]);
    expect(order).toEqual(['implement', 'validate']);
  });

  it('cancels queued work without invoking it', async () => {
    const coordinator = new SubagentCoordinator({...COMPATIBILITY_PROFILE, maxConcurrency: 1});
    const gate = deferred();
    const first = coordinator.submit<Result>({id: 'first', mode: 'inspect', run: async () => { await gate.promise; return {id: 'first', termination: 'completed'}; }, terminal: terminal('first'), terminationOf: result => result.termination});
    const controller = new AbortController();
    let invoked = false;
    const second = coordinator.submit<Result>({id: 'second', mode: 'inspect', signal: controller.signal, run: async () => { invoked = true; return {id: 'second', termination: 'completed'}; }, terminal: terminal('second'), terminationOf: result => result.termination});
    await Promise.resolve();
    controller.abort();
    await expect(second).resolves.toMatchObject({termination: 'cancelled'});
    expect(invoked).toBe(false);
    gate.resolve();
    await first;
  });

  it('aborts active work at the elapsed deadline', async () => {
    const coordinator = new SubagentCoordinator({...COMPATIBILITY_PROFILE, deadlineMs: 10});
    const result = await coordinator.submit<Result>({
      id: 'deadline', mode: 'inspect',
      run: async ({signal, deadlineExpired}) => await new Promise<Result>(resolve => signal.addEventListener('abort', () => resolve({id: 'deadline', termination: deadlineExpired() ? 'deadline_exceeded' : 'cancelled'}), {once: true})),
      terminal: terminal('deadline'), terminationOf: value => value.termination,
    });
    expect(result.termination).toBe('deadline_exceeded');
  });

  it('returns at the hard deadline but quarantines an ignored abort until physical settlement', async () => {
    const events: Array<{type: string; id: string; execution?: string}> = [];
    const coordinator = new SubagentCoordinator({...COMPATIBILITY_PROFILE, maxConcurrency: 1, deadlineMs: 10}, event => events.push(event));
    const lingering = deferred();
    const first = coordinator.submit<Result>({id: 'lingering', mode: 'implement', run: async () => { await lingering.promise; return {id: 'lingering', termination: 'completed'}; }, terminal: terminal('lingering'), terminationOf: value => value.termination});
    await expect(first).resolves.toMatchObject({termination: 'deadline_exceeded'});
    expect(events).toContainEqual(expect.objectContaining({type: 'terminal', id: 'lingering', execution: 'quarantined'}));

    let nextStarted = false;
    const next = coordinator.submit<Result>({id: 'next', mode: 'implement', run: async () => { nextStarted = true; return {id: 'next', termination: 'completed'}; }, terminal: terminal('next'), terminationOf: value => value.termination});
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(nextStarted).toBe(false);
    lingering.resolve();
    await expect(next).resolves.toMatchObject({termination: 'completed'});
    expect(events).toContainEqual(expect.objectContaining({type: 'settled', id: 'lingering'}));
  });

  it('keeps a quarantined worker mutation lease until underlying work is quiescent', async () => {
    const policy = new WorkspaceMutationPolicy();
    const workerOwner = policy.createOwner();
    const gate = deferred();
    const coordinator = new SubagentCoordinator({...COMPATIBILITY_PROFILE, deadlineMs: 5});
    const pending = coordinator.submit<Result>({id: 'lease', mode: 'implement', run: async () => {
      const release = await policy.acquire(workerOwner);
      try { await gate.promise; } finally { release(); }
      return {id: 'lease', termination: 'completed'};
    }, terminal: terminal('lease'), terminationOf: value => value.termination});
    await expect(pending).resolves.toMatchObject({termination: 'deadline_exceeded'});
    let mainAcquired = false;
    const mainLease = policy.acquire(policy.createOwner()).then(release => { mainAcquired = true; return release; });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(mainAcquired).toBe(false);
    gate.resolve();
    const releaseMain = await mainLease;
    expect(mainAcquired).toBe(true);
    releaseMain();
  });

  it('uses the first abort source in parent-before-deadline and deadline-before-parent races', async () => {
    const runRace = async (parentFirst: boolean) => {
      const gate = deferred();
      const controller = new AbortController();
      const coordinator = new SubagentCoordinator({...COMPATIBILITY_PROFILE, deadlineMs: parentFirst ? 30 : 5});
      const pending = coordinator.submit<Result>({id: 'race', mode: 'inspect', signal: controller.signal, run: async () => { await gate.promise; return {id: 'race', termination: 'completed'}; }, terminal: terminal('race'), terminationOf: value => value.termination});
      if (parentFirst) setTimeout(() => controller.abort('user'), 5);
      else setTimeout(() => controller.abort('user'), 20);
      const result = await pending;
      await new Promise(resolve => setTimeout(resolve, 35));
      gate.resolve();
      return result.termination;
    };
    await expect(runRace(true)).resolves.toBe('cancelled');
    await expect(runRace(false)).resolves.toBe('deadline_exceeded');
  });

  it('classifies an unexpected run rejection as provider_error', async () => {
    const coordinator = new SubagentCoordinator({...COMPATIBILITY_PROFILE, deadlineMs: 100});
    await expect(coordinator.submit<Result>({id: 'error', mode: 'inspect', run: async () => { throw new Error('boom'); }, terminal: terminal('error'), terminationOf: value => value.termination})).resolves.toMatchObject({termination: 'provider_error'});
  });

  it('emits exactly one settled terminal event for a pre-aborted submission', async () => {
    const events: Array<{type: string; execution?: string}> = [];
    const controller = new AbortController();
    controller.abort();
    const coordinator = new SubagentCoordinator(COMPATIBILITY_PROFILE, event => events.push(event));
    await coordinator.submit<Result>({id: 'pre', mode: 'inspect', signal: controller.signal, run: async () => ({id: 'pre', termination: 'completed'}), terminal: terminal('pre'), terminationOf: value => value.termination});
    expect(events).toEqual([expect.objectContaining({type: 'terminal', execution: 'settled'})]);
  });

  it('does not let later reads bypass and starve an older queued mutation', async () => {
    const coordinator = new SubagentCoordinator({...COMPATIBILITY_PROFILE, maxConcurrency: 2, deadlineMs: 500});
    const gate = deferred();
    const order: string[] = [];
    const active = coordinator.submit<Result>({id: 'active', mode: 'implement', run: async () => { order.push('active'); await gate.promise; return {id: 'active', termination: 'completed'}; }, terminal: terminal('active'), terminationOf: value => value.termination});
    await new Promise(resolve => setTimeout(resolve, 0));
    const mutation = coordinator.submit<Result>({id: 'mutation', mode: 'validate', run: async () => { order.push('mutation'); return {id: 'mutation', termination: 'completed'}; }, terminal: terminal('mutation'), terminationOf: value => value.termination});
    const reads = Array.from({length: 4}, (_, index) => coordinator.submit<Result>({id: `read-${index}`, mode: 'inspect', run: async () => { order.push(`read-${index}`); return {id: `read-${index}`, termination: 'completed'}; }, terminal: terminal(`read-${index}`), terminationOf: value => value.termination}));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(order).toEqual(['active']);
    gate.resolve();
    await Promise.all([active, mutation, ...reads]);
    expect(order[1]).toBe('mutation');
  });
});
