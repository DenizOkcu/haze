import {describe, expect, it} from 'vitest';
import {terminalTurnStatus} from '../../src/cli/commands/streaming/turnOutcome.js';

describe('terminalTurnStatus', () => {
  it('requires a substantive answer after tools and rejects final failures/budget stops', () => {
    expect(terminalTurnStatus({aborted: false, assistantText: 'Done.', sawToolCall: true, lastToolOk: true})).toBe('complete');
    expect(terminalTurnStatus({aborted: false, assistantText: '', sawToolCall: true, lastToolOk: true})).toBe('failed');
    expect(terminalTurnStatus({aborted: false, assistantText: 'Done.', sawToolCall: true, lastToolOk: false})).toBe('failed');
    expect(terminalTurnStatus({aborted: false, assistantText: 'partial', sawToolCall: true, budgetReached: true})).toBe('failed');
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
