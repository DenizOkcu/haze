import {describe, expect, it} from 'vitest';
import {handleAttemptFailure, projectGoalEvidence, terminalTurnStatus} from '../../../../src/cli/commands/streaming/attemptOutcome.js';
import {createTurnExecutionState} from '../../../../src/core/agent/completionController.js';
import {createSessionGoal, observeGoalToolEvent} from '../../../../src/core/agent/goalPolicy.js';
import type {TurnAbortCause} from '../../../../src/cli/commands/streaming/abortCause.js';
import type {StreamCallbacks} from '../../../../src/cli/commands/streaming.js';
import type {Message} from '../../../../src/cli/commands/streaming.js';

describe('projectGoalEvidence', () => {
  it('preserves cumulative mutation and validation state for abnormal terminal paths', () => {
    const goal = createSessionGoal('implement the CLI');
    observeGoalToolEvent(goal, {toolName: 'writeFile', input: {path: 'cli.js'}, success: true, output: {ok: true}});
    const state = createTurnExecutionState();
    projectGoalEvidence(state, goal);
    expect(state).toMatchObject({intent: 'implement', mutationCount: 1, validationOutcome: 'absent', validationAfterMutation: false});
  });
});

describe('terminalTurnStatus', () => {
  it('requires a substantive answer after tools and rejects final failures/budget stops', () => {
    expect(terminalTurnStatus({aborted: false, assistantText: 'Done.', sawToolCall: true, lastToolOk: true})).toBe('complete');
    expect(terminalTurnStatus({aborted: false, assistantText: '', sawToolCall: true, lastToolOk: true})).toBe('failed');
    expect(terminalTurnStatus({aborted: false, assistantText: 'Done.', sawToolCall: true, lastToolOk: false})).toBe('failed');
    expect(terminalTurnStatus({aborted: false, assistantText: 'partial', sawToolCall: true, budgetReached: true})).toBe('failed');
    expect(terminalTurnStatus({aborted: false, assistantText: 'partial', sawToolCall: true, lastToolOk: true, finishReason: 'stop', intent: 'implement', mutationCount: 1, validationOutcome: 'passed', budgetReached: true})).toBe('complete');
    expect(terminalTurnStatus({aborted: false, assistantText: "I'll retry with smaller writes.", sawToolCall: true, unresolvedToolInputError: true})).toBe('failed');
    expect(terminalTurnStatus({aborted: true, assistantText: '', sawToolCall: false})).toBe('aborted');
    expect(terminalTurnStatus({aborted: false, assistantText: '', sawToolCall: false, finishReason: 'stop'})).toBe('failed');
  });

  it('rejects a substantive final while declared tasks remain (roadmap regression)', () => {
    expect(terminalTurnStatus({
      aborted: false,
      assistantText: 'Next unfinished action: implement the tool.',
      sawToolCall: true,
      lastToolOk: true,
      finishReason: 'stop',
      intent: 'implement',
      taskProgress: {total: 5, pending: 5, inProgress: 0, completed: 0, revision: 2},
    })).toBe('failed');
  });

  it('rejects a substantive final when edits lack fresh relevant validation (implement/fix/test)', () => {
    const base = {aborted: false, assistantText: 'Done.', sawToolCall: true, lastToolOk: true, finishReason: 'stop', intent: 'implement' as const, mutationCount: 1};
    expect(terminalTurnStatus({...base, validationOutcome: 'absent'})).toBe('failed');
    expect(terminalTurnStatus({...base, validationOutcome: 'stale'})).toBe('failed');
    expect(terminalTurnStatus({...base, validationOutcome: 'failed'})).toBe('failed');
    expect(terminalTurnStatus({...base, validationOutcome: 'passed'})).toBe('complete');
    // Without mutations, absent validation does not block an honest answer.
    expect(terminalTurnStatus({...base, mutationCount: 0, validationOutcome: 'absent'})).toBe('complete');
  });

  it('keeps plan/review/answer turns free of mutation/validation gating', () => {
    for (const intent of ['plan', 'review', 'answer'] as const) {
      expect(terminalTurnStatus({aborted: false, assistantText: 'Here is the plan.', sawToolCall: true, lastToolOk: true, finishReason: 'stop', intent, mutationCount: 0, validationOutcome: 'not_applicable'})).toBe('complete');
    }
  });
});

function makeFailureCallbacks() {
  const messages: Message[] = [];
  const events: Array<{type: string; [key: string]: unknown}> = [];
  let conversation: import('ai').ModelMessage[] = [];
  const callbacks = {
    addMessage: (msg: Message) => messages.push(msg),
    updateMessage: () => undefined,
    setConversation: (msgs: import('ai').ModelMessage[]) => {
      conversation = msgs;
    },
    setBusy: () => undefined,
    debugLog: () => undefined,
    getConversation: () => conversation,
    getLastAssistantText: () => '',
    setLastAssistantText: () => undefined,
    onEvent: (event: {type: string}) => {
      events.push(event);
    },
    compactConversation: (instructions?: string) => {
      if (conversation.length <= 1) return false;
      conversation = [{role: 'user', content: `<haze_compaction>\ncompacted (${instructions ?? ''})\n</haze_compaction>`}];
      return true;
    },
  } satisfies StreamCallbacks;
  return {callbacks, messages, events};
}

const userAbortCause: TurnAbortCause = {kind: 'user'};

function failureDeps(overrides: Partial<Parameters<typeof handleAttemptFailure>[0]> = {}) {
  const {callbacks, messages, events} = makeFailureCallbacks();
  callbacks.setConversation([{role: 'user', content: 'implement the feature'}, {role: 'assistant', content: 'partial'}, {role: 'user', content: 'continue'}]);
  return {
    deps: {
      value: 'implement the feature',
      callbacks,
      abortController: new AbortController(),
      turnState: createTurnExecutionState(),
      retryAttempt: 0,
      abortCause: userAbortCause,
      stallGuard: undefined,
      salvage: {requestMessages: [], accumulated: []},
      error: new Error('Service overloaded (503)'),
      goal: createSessionGoal('implement the feature'),
      turnOptions: {},
      ...overrides,
    } satisfies Parameters<typeof handleAttemptFailure>[0],
    messages,
    events,
  };
}

describe('handleAttemptFailure: retry pool resets on progress (Pillar 1.3)', () => {
  it('resets the shared pool when the failed attempt completed steps since the last retry', () => {
    // Pool was exhausted (attempt 2 of 2), but the attempt made progress.
    const {deps, messages} = failureDeps({retryAttempt: 2, progressSinceLastRetry: true});
    const result = handleAttemptFailure(deps);
    expect(result.retry).toMatchObject({attempt: 1});
    expect(messages.some(m => /retrying attempt 1\/2/.test(m.text))).toBe(true);
  });

  it('keeps chaining backoff when no progress was made since the last retry', () => {
    const {deps} = failureDeps({retryAttempt: 2, progressSinceLastRetry: false});
    const result = handleAttemptFailure(deps);
    expect(result.retry).toBeUndefined();
  });
});

describe('handleAttemptFailure: bounded overflow recovery (Pillar 1.4)', () => {
  it('compacts and retries at a shrunk budget on the first overflow', () => {
    const {deps, messages, events} = failureDeps({error: new Error('Request exceeds maximum context length'), overflowRetries: 0});
    const result = handleAttemptFailure(deps);
    expect(result.retry).toMatchObject({attempt: 0, delayMs: 0, overflowShrinkFactor: 0.6});
    expect(messages.some(m => /60% of the message budget/.test(m.text))).toBe(true);
    expect(events.some(event => event.type === 'compaction_start' && event.reason === 'overflow')).toBe(true);
    expect(events.find(event => event.type === 'context_overflow')).toMatchObject({recovered: true});
  });

  it('shrinks further on the second overflow retry', () => {
    const {deps} = failureDeps({error: new Error('prompt is too long'), overflowRetries: 1});
    expect(handleAttemptFailure(deps).retry).toMatchObject({overflowShrinkFactor: 0.36});
  });

  it('checkpoints the goal instead of hard-failing once overflow retries are exhausted', () => {
    const {deps, messages, events} = failureDeps({error: new Error('prompt is too long'), overflowRetries: 2});
    const result = handleAttemptFailure(deps);
    expect(result.status).toBe('failed');
    expect(result.retry).toBeUndefined();
    expect(result.resume).toMatchObject({kind: 'incomplete-goal', reason: 'context_exhausted'});
    expect(messages.some(m => /pausing the goal with a checkpoint/.test(m.text))).toBe(true);
    expect(events.find(event => event.type === 'context_overflow')).toMatchObject({recovered: false});
  });

  it('reports honestly when compaction is unavailable or declines', () => {
    const unavailable = failureDeps({error: new Error('prompt is too long')});
    delete (unavailable.deps.callbacks as {compactConversation?: unknown}).compactConversation;
    handleAttemptFailure(unavailable.deps);
    expect(unavailable.messages.some(m => /does not attempt automatic compaction/.test(m.text))).toBe(true);
  });
});
