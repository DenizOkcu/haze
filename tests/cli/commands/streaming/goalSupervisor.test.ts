import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {GoalCheckpoint} from '../../../../src/cli/commands/streaming/goalCheckpoint.js';
import {checkpointFromGoalFrontier} from '../../../../src/cli/commands/streaming/goalCheckpoint.js';
import type {IncompleteGoalResume} from '../../../../src/cli/commands/streaming/goalCheckpoint.js';
import type {GoalRunOptions, GoalRunResult} from '../../../../src/cli/commands/streaming/goalSupervisor.js';
import type {TurnResult, TurnExecutionOptions} from '../../../../src/cli/commands/streaming.js';

/**
 * Unit-level tests for the logical-goal supervisor: runAgentTurn is scripted,
 * so every decision branch (auto-continue, progress accounting, deadlines,
 * aborts, pauses, seeding) is exercised deterministically.
 */
interface ScriptedTurn {
  result: TurnResult;
  /** Optional assertion hook observing the exact options passed for this turn. */
  inspect?: (options: TurnExecutionOptions, args: {retryAttempt: number; retryingExistingRequest: boolean}) => void;
}

const calls = vi.hoisted(() => ({
  turns: [] as ScriptedTurn[],
  options: [] as TurnExecutionOptions[],
  positional: [] as Array<{retryAttempt: number; retryingExistingRequest: boolean}>,
}));

function incompleteGoalResume(over: Partial<IncompleteGoalResume> = {}): IncompleteGoalResume {
  return {
    kind: 'incomplete-goal',
    request: 'implement the roadmap feature',
    reason: 'pending_tasks',
    goalId: 'goal-test',
    cycle: 1,
    stepsUsed: 40,
    mutationCount: 3,
    taskCounts: {total: 7, pending: 6, inProgress: 1, completed: 0},
    validationOutcome: 'stale',
    ...over,
  };
}

function turnResult(status: TurnResult['status'], over: Partial<TurnResult> = {}): TurnResult {
  return {status, ...over};
}

function makeCallbacks() {
  const messages: Array<{role: string; text: string}> = [];
  const events: Array<{type: string; [key: string]: unknown}> = [];
  return {
    addMessage: (msg: {role: string; text: string}) => {
      messages.push(msg);
    },
    updateMessage: () => undefined,
    setConversation: () => undefined,
    setBusy: () => undefined,
    setBusyLabel: () => undefined,
    debugLog: () => undefined,
    getConversation: () => [],
    getLastAssistantText: () => '',
    setLastAssistantText: () => undefined,
    onEvent: (event: {type: string}) => {
      events.push(event);
    },
    messages,
    events,
  };
}

async function loadSupervisor(scripted: ScriptedTurn[]) {
  calls.turns = scripted;
  calls.options = [];
  calls.positional = [];
  vi.doMock('../../../../src/cli/commands/streaming.js', () => ({
    runAgentTurn: async (_value: string, _display: string | undefined, _contextFiles: unknown, _callbacks: unknown, retryAttempt: number, retryingExistingRequest: boolean, _overflow: boolean, _session: unknown, _modelOverride: string | undefined, options: TurnExecutionOptions) => {
      const index = calls.positional.length;
      calls.options.push(options);
      calls.positional.push({retryAttempt, retryingExistingRequest});
      const scriptedTurn = calls.turns[Math.min(index, calls.turns.length - 1)];
      scriptedTurn.inspect?.(options, {retryAttempt, retryingExistingRequest});
      return scriptedTurn.result;
    },
  }));
  vi.resetModules();
  return import('../../../../src/cli/commands/streaming/goalSupervisor.js');
}

function baseOptions(over: Partial<GoalRunOptions> = {}): GoalRunOptions {
  return {request: 'implement the roadmap feature', contextFiles: [], callbacks: makeCallbacks(), ...over};
}

beforeEach(() => {
  calls.turns = [];
  calls.options = [];
  calls.positional = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runAgentGoal: automatic continuation across physical turns', () => {
  let cycle0GoalId: string | undefined;
  it('emits goal_continue with a descriptive text and a goal_notice on pause', async () => {
    const {runAgentGoal} = await loadSupervisor([
      {result: turnResult('failed', {resume: incompleteGoalResume()})},
      {result: turnResult('failed', {resume: incompleteGoalResume({cycle: 2, mutationCount: 3, progressSignature: '["9","stale",[7,2,0,5]]'})},
      )},
      {result: turnResult('failed', {resume: incompleteGoalResume({cycle: 3, mutationCount: 3, progressSignature: '["9","stale",[7,2,0,5]]'})},
      )},
    ]);
    const cb = makeCallbacks();
    const result = await runAgentGoal(baseOptions({callbacks: cb}));
    // Second no-progress cycle pauses the goal with a named, human-readable reason.
    expect(result).toMatchObject({status: 'failed', stopReason: 'no-progress'});
    const continueEvent = cb.events.find(event => event.type === 'goal_continue') as {reason?: string; text?: string};
    expect(continueEvent?.text).toContain('pending');
    expect(cb.events.some(event => event.type === 'goal_notice' && String(event.text).includes('Unfinished goal paused'))).toBe(true);
  });

  it('continues automatically after a budget-boundary checkpoint and completes in the next physical turn', async () => {
    const {runAgentGoal} = await loadSupervisor([
      {
        result: turnResult('failed', {resume: incompleteGoalResume()}),
        inspect: options => {
          cycle0GoalId = options.goalContext?.goalId;
        },
      },
      {
        result: turnResult('complete', {evidence: {validationOutcome: 'passed', validationAfterMutation: true, mutationCount: 5, taskProgress: {total: 7, pending: 0, inProgress: 0, completed: 7}, finishCause: 'stop', recoveryUsed: {length: false, rescue: false, goal: 0}, budgetBoundary: false}}),
        inspect: (options, {retryingExistingRequest}) => {
          // The continuation turn rides the preserved conversation: no duplicate
          // user message, and carries the continuation control + carried evidence.
          expect(retryingExistingRequest).toBe(true);
          expect(options.ephemeralControl).toMatch(/Continue the active goal/);
          expect(options.goalContext?.carried.mutationCount).toBe(3);
          expect(options.goalContext?.carried.validationOutcome).toBe('stale');
          expect(options.goalContext?.carried.taskProgress).toMatchObject({total: 7, pending: 6});
          // The logical goal identity is continuous across physical turns.
          expect(options.goalContext?.goalId).toBe(cycle0GoalId);
        },
      },
    ]);
    const cb = makeCallbacks();
    const result = await runAgentGoal(baseOptions({callbacks: cb}));
    expect(result).toMatchObject({status: 'complete', stopReason: 'completed', cycles: 2});
    // Exactly one goal_start / one terminal goal_end, plus goal_continue between turns.
    expect(cb.events.filter(event => event.type === 'goal_start')).toHaveLength(1);
    expect(cb.events.filter(event => event.type === 'goal_continue')).toHaveLength(1);
    expect(cb.events.filter(event => event.type === 'goal_end')).toHaveLength(1);
    expect(cb.events.find(event => event.type === 'goal_end')).toMatchObject({status: 'complete', cycles: 2});
    // Visible continuation status, not a pause demand.
    expect(cb.messages.some(m => m.role === 'system' && /Continuing unfinished goal — cycle 2/.test(m.text))).toBe(true);
    expect(cb.messages.some(m => /Press R/.test(m.text))).toBe(false);
    expect(result.resume).toBeUndefined();
  });

  it('keeps continuing across several budget boundaries while task progress accumulates', async () => {
    const {runAgentGoal} = await loadSupervisor([
      {result: turnResult('failed', {resume: incompleteGoalResume()})},
      {result: turnResult('failed', {resume: incompleteGoalResume({cycle: 2, mutationCount: 5, taskCounts: {total: 7, pending: 3, inProgress: 1, completed: 3}})})},
      {result: turnResult('complete', {evidence: {validationOutcome: 'passed', validationAfterMutation: true, mutationCount: 8, taskProgress: {total: 7, pending: 0, inProgress: 0, completed: 7}, finishCause: 'stop', recoveryUsed: {length: false, rescue: false, goal: 0}, budgetBoundary: false}})},
    ]);
    const cb = makeCallbacks();
    const result = await runAgentGoal(baseOptions({callbacks: cb}));
    expect(result.status).toBe('complete');
    expect(result.cycles).toBe(3);
    expect(cb.events.filter(event => event.type === 'goal_continue')).toHaveLength(2);
    // Cumulative mutations in the terminal evidence, not per-turn resets.
    expect(cb.events.find(event => event.type === 'goal_end')).toMatchObject({cycles: 3});
  });

  it('pauses safely after one corrective no-progress cycle, with a resumable checkpoint', async () => {
    const {runAgentGoal} = await loadSupervisor([
      {result: turnResult('failed', {resume: incompleteGoalResume()})},
      // Corrective cycle: identical evidence signature (no measurable progress).
      {result: turnResult('failed', {resume: incompleteGoalResume()})},
    ]);
    const cb = makeCallbacks();
    const result = await runAgentGoal(baseOptions({callbacks: cb}));
    // Cycle 1 establishes the baseline; cycle 2 is the single corrective
    // no-progress cycle and then pauses.
    expect(result).toMatchObject({status: 'failed', stopReason: 'no-progress', cycles: 2});
    expect(result.resume?.kind).toBe('incomplete-goal');
    expect((result.resume as {checkpoint: GoalCheckpoint}).checkpoint).toMatchObject({readiness: 'pending_tasks', noProgressCount: 1});
    expect(cb.messages.some(m => m.role === 'system' && /paused after 1 corrective cycle without measurable progress/.test(m.text))).toBe(true);
    expect(cb.events.filter(event => event.type === 'goal_end')).toHaveLength(1);
  });

  it('treats changed task outcomes as progress but not mutation-counter churn', async () => {
    const {runAgentGoal} = await loadSupervisor([
      {result: turnResult('failed', {resume: incompleteGoalResume()})},
      // More completed work — measurable progress resets the no-progress guard.
      {result: turnResult('failed', {resume: incompleteGoalResume({mutationCount: 6, taskCounts: {total: 7, pending: 5, inProgress: 1, completed: 1}})})},
      // First consecutive no-progress cycle: allowed as the corrective cycle.
      {result: turnResult('failed', {resume: incompleteGoalResume({mutationCount: 6, taskCounts: {total: 7, pending: 5, inProgress: 1, completed: 1}})})},
    ]);
    const cb = makeCallbacks();
    const result = await runAgentGoal(baseOptions({callbacks: cb}));
    // The changed task counts reset progress once; the next identical outcome
    // consumes the single corrective cycle and pauses.
    expect(result.cycles).toBe(3);
    expect(result.stopReason).toBe('no-progress');
  });

  it('stops immediately on user cancellation during automatic continuation', async () => {
    const {runAgentGoal} = await loadSupervisor([
      {result: turnResult('failed', {resume: incompleteGoalResume()})},
      {result: turnResult('aborted')},
    ]);
    const cb = makeCallbacks();
    const result = await runAgentGoal(baseOptions({callbacks: cb}));
    expect(result).toMatchObject({status: 'aborted', stopReason: 'user-aborted', cycles: 2});
    expect(cb.events.filter(event => event.type === 'goal_end')).toHaveLength(1);
    expect(result.resume).toBeUndefined();
  });

  it('reports an internal turn deadline as goal-deadline, not user-aborted', async () => {
    const {runAgentGoal} = await loadSupervisor([
      {result: turnResult('aborted', {abortReason: 'turn-deadline', evidence: {validationOutcome: 'absent', validationAfterMutation: false, mutationCount: 3, finishCause: undefined, recoveryUsed: {length: false, rescue: false, goal: 0}, budgetBoundary: false}})},
    ]);
    const result = await runAgentGoal(baseOptions());
    expect(result).toMatchObject({status: 'failed', stopReason: 'goal-deadline', cycles: 1, evidence: {mutationCount: 3}});
  });

  it('stops for hard failures without an incomplete-goal checkpoint', async () => {
    const {runAgentGoal} = await loadSupervisor([
      {result: turnResult('failed', {evidence: {validationOutcome: 'not_applicable', validationAfterMutation: false, mutationCount: 0, finishCause: 'stop', recoveryUsed: {length: false, rescue: false, goal: 0}, budgetBoundary: false}})},
    ]);
    const cb = makeCallbacks();
    const result = await runAgentGoal(baseOptions({callbacks: cb}));
    expect(result).toMatchObject({status: 'failed', stopReason: 'blocked', cycles: 1});
    expect(cb.events.filter(event => event.type === 'goal_continue')).toHaveLength(0);
    expect(result.resume).toBeUndefined();
  });

  it('preserves the idle-stall pause path with its retry-pool resume', async () => {
    const {runAgentGoal} = await loadSupervisor([
      {result: turnResult('failed', {resume: {kind: 'model-stream-idle', request: 'implement the roadmap feature', retryAttempt: 2}})},
    ]);
    const cb = makeCallbacks();
    const result = await runAgentGoal(baseOptions({callbacks: cb}));
    expect(result).toMatchObject({status: 'failed', stopReason: 'model-stream-idle', cycles: 1});
    expect(result.resume).toEqual({kind: 'model-stream-idle', request: 'implement the roadmap feature', retryAttempt: 2});
  });

  it('respects the whole-goal deadline: stops as failed before starting an overdue cycle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const {runAgentGoal} = await loadSupervisor([
      {result: turnResult('failed', {resume: incompleteGoalResume()})},
    ]);
    const cb = makeCallbacks();
    const promise = runAgentGoal(baseOptions({callbacks: cb, goalDeadlineMs: 60_000}));
    // Simulate the first physical turn consuming the whole goal budget.
    vi.setSystemTime(1_000 + 61_000);
    const result: GoalRunResult = await promise;
    expect(result).toMatchObject({status: 'failed', stopReason: 'goal-deadline', cycles: 1});
    expect(result.resume?.kind).toBe('incomplete-goal');
    expect(cb.messages.some(m => /Goal deadline reached/.test(m.text))).toBe(true);
    expect(calls.positional).toHaveLength(1);
    vi.useRealTimers();
  });

  it('clamps each physical turn deadline to the remaining goal budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const {runAgentGoal} = await loadSupervisor([
      {
        result: turnResult('failed', {resume: incompleteGoalResume()}),
        inspect: options => {
          // First physical turn sees the whole goal budget (capped per turn).
          expect(options.turnDeadlineMs).toBe(150_000);
          // Simulate the first turn consuming 30s of the goal budget.
          vi.setSystemTime(30_000);
        },
      },
      {
        result: turnResult('complete'),
        inspect: options => {
          expect(options.turnDeadlineMs).toBe(120_000);
        },
      },
    ]);
    await runAgentGoal(baseOptions({goalDeadlineMs: 150_000}));
    expect(calls.positional).toHaveLength(2);
    vi.useRealTimers();
  });

  it('shares one turn scope and never re-adds attachments on continuation turns', async () => {
    const {runAgentGoal} = await loadSupervisor([
      {
        result: turnResult('failed', {resume: incompleteGoalResume()}),
        inspect: (options, {retryingExistingRequest}) => {
          expect(retryingExistingRequest).toBe(false);
          expect(options.attachments).toBeDefined();
        },
      },
      {
        result: turnResult('complete'),
        inspect: options => {
          expect(options.attachments).toBeUndefined();
          expect(options.sharedTurnScope).toBe(calls.options[0]?.sharedTurnScope);
        },
      },
    ]);
    await runAgentGoal(baseOptions({turnOptions: {attachments: [{displayPath: 's.png', absolutePath: '/tmp/s.png', fileName: 's.png', mediaType: 'image/png', bytes: 1, data: new Uint8Array([1])}] as never}}));
    expect(calls.positional).toHaveLength(2);
  });

  it('resumes from a stored checkpoint: hydrates carried evidence and continues the same goal id', async () => {
    const checkpoint: GoalCheckpoint = {
      goalId: 'goal-persisted',
      request: 'implement the roadmap feature',
      cycle: 2,
      readiness: 'validation_stale',
      taskCounts: {total: 7, pending: 2, inProgress: 0, completed: 5},
      mutationCount: 9,
      validationOutcome: 'stale',
      progressSignature: '["9","stale",[7,2,0,5]]',
      noProgressCount: 1,
    };
    const {runAgentGoal} = await loadSupervisor([
      {
        result: turnResult('complete'),
        inspect: (options, {retryingExistingRequest}) => {
          expect(retryingExistingRequest).toBe(true);
          expect(options.goalContext?.goalId).toBe('goal-persisted');
          expect(options.goalContext?.cycle).toBe(3);
          expect(options.goalContext?.carried).toMatchObject({mutationCount: 9, validationOutcome: 'stale'});
        },
      },
    ]);
    const cb = makeCallbacks();
    const result = await runAgentGoal(baseOptions({callbacks: cb, resumeFrom: {kind: 'incomplete-goal', checkpoint}}));
    expect(result).toMatchObject({status: 'complete', cycles: 3});
    expect(cb.events.find(event => event.type === 'goal_start')).toMatchObject({goalId: 'goal-persisted'});
  });
});

describe('runAgentGoal: durable goal ledger (P1)', () => {
  it('appends one entry per boundary: start, continue, and terminal end with hash binding', async () => {
    const entries: Array<{phase: string; [key: string]: unknown}> = [];
    const {runAgentGoal} = await loadSupervisor([
      {result: turnResult('failed', {resume: incompleteGoalResume()})},
      {result: turnResult('complete', {evidence: {validationOutcome: 'passed', validationAfterMutation: true, mutationCount: 3, finishCause: 'stop', recoveryUsed: {length: false, rescue: false, goal: 0}, budgetBoundary: false}})},
    ]);
    const result = await runAgentGoal(baseOptions({goalLedger: {append: entry => entries.push({...entry, phase: entry.phase})}}));
    expect(result).toMatchObject({status: 'complete'});
    expect(entries.map(entry => entry.phase)).toEqual(['goal_start', 'goal_continue', 'goal_end']);
    const start = entries[0]!;
    expect(start.requestHash).toMatch(/^[0-9a-f]{16}$/);
    expect(start.intent).toBe('implement');
    expect(start.cycle).toBe(0);
    expect(start).not.toHaveProperty('asks');
    expect(start).not.toHaveProperty('shape');
    const continueEntry = entries[1]!;
    expect(continueEntry.cycle).toBe(1);
    expect(continueEntry.mutationCount).toBe(3);
    const end = entries[2]!;
    expect(end.phase).toBe('goal_end');
    expect(end.status).toBe('complete');
  });

  it('resumes from a stored-goal frontier without re-sending the request', async () => {
    const checkpoint: GoalCheckpoint = {
      goalId: 'goal-crashed',
      request: 'implement the roadmap feature',
      cycle: 4,
      mutationCount: 6,
      validationOutcome: 'stale',
      progressSignature: 'sig',
      noProgressCount: 0,
      requestHash: 'cafe1234',
      redEvidence: {command: 'npm test', commandKey: 'npm test', summary: 'red'},
    };
    const {runAgentGoal} = await loadSupervisor([
      {
        result: turnResult('complete'),
        inspect: (options, {retryingExistingRequest}) => {
          expect(retryingExistingRequest).toBe(true);
          expect(options.goalContext?.goalId).toBe('goal-crashed');
          expect(options.goalContext?.requestHash).toBe('cafe1234');
          expect(options.goalContext?.carried).toMatchObject({redEvidence: {command: 'npm test'}});
          expect(String(options.ephemeralControl)).toContain('Continue the active goal');
        },
      },
    ]);
    const result = await runAgentGoal(baseOptions({resumeFrom: {kind: 'stored-goal', checkpoint}}));
    expect(result).toMatchObject({status: 'complete', cycles: 5});
  });

  it('re-enters against a preserved conversation without a checkpoint when asked (P6 relaunch)', async () => {
    const {runAgentGoal} = await loadSupervisor([
      {
        result: turnResult('complete'),
        inspect: (options, {retryingExistingRequest}) => {
          expect(retryingExistingRequest).toBe(true);
        },
      },
    ]);
    const result = await runAgentGoal(baseOptions({conversationCarriesRequest: true}));
    expect(result).toMatchObject({status: 'complete'});
  });
});

describe('stored-goal frontier parity (P1: crash resume matches in-process continuation)', () => {
  it('carries red→green evidence from the ledger frontier', async () => {
    const checkpoint = checkpointFromGoalFrontier({
      goalId: 'goal-crashed',
      request: 'fix the login crash',
      requestHash: 'deadbeef',
      intent: 'fix',
      cycle: 3,
      mutationCount: 4,
      validationOutcome: 'stale',
      progressSignature: 'sig',
      at: 't0',
      taskCounts: {total: 4, pending: 1, inProgress: 0, completed: 3},
      redEvidence: {command: 'npm test', commandKey: 'npm test', summary: 'red'},
      redWaiverReason: 'unobservable',
      greenSuccessor: 'npm run test:ci',
    });
    expect(checkpoint).toMatchObject({
      goalId: 'goal-crashed',
      requestHash: 'deadbeef',
      intent: 'fix',
      cycle: 3,
      redEvidence: {command: 'npm test'},
      redWaiver: {reason: 'unobservable'},
      greenSuccessor: 'npm run test:ci',
    });
    // The stored-goal resume hydrates exactly this carried evidence.
    const {runAgentGoal} = await loadSupervisor([
      {
        result: turnResult('complete'),
        inspect: options => {
          expect(options.goalContext?.carried).toMatchObject({
            redEvidence: {command: 'npm test'},
            redWaiver: {reason: 'unobservable'},
            greenSuccessor: 'npm run test:ci',
          });
        },
      },
    ]);
    const result = await runAgentGoal(baseOptions({resumeFrom: {kind: 'stored-goal', checkpoint}}));
    expect(result).toMatchObject({status: 'complete', cycles: 4});
  });
});
