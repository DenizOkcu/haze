import {describe, expect, it} from 'vitest';
import {
  createTurnExecutionState,
  decideLengthRecovery,
  decideRescue,
  decideTerminalStatus,
  hasSatisfactoryTerminalOutcome,
  hasRemainingRecoveryBudget,
  isBudgetExhausted,
  normalizeFinishReason,
  RESCUE_BOUNDARY,
  toCompletionEvidence,
  type CompletionEvidence,
  type TurnExecutionState,
} from '../../src/core/agent/completionController.js';
import {mainTurnBudget} from '../../src/core/agent/turnBudget.js';

const budget = mainTurnBudget();

function evidence(over: Partial<CompletionEvidence> = {}): CompletionEvidence {
  return {sawToolCall: false, assistantText: '', lastToolOk: undefined, unresolvedToolInputError: false, ...over};
}

function state(over: Partial<TurnExecutionState> = {}): TurnExecutionState {
  return {...createTurnExecutionState(), ...over};
}

describe('normalizeFinishReason', () => {
  it.each([
    ['stop', 'stop'],
    ['length', 'length'],
    ['tool-calls', 'tool-calls'],
    ['error', 'error'],
    ['content-filter', 'content-filter'],
    [undefined, 'unknown'],
    ['garbage', 'unknown'],
  ])('maps %s -> %s', (input, expected) => {
    expect(normalizeFinishReason(input)).toBe(expected);
  });
});

describe('isBudgetExhausted (turn-wide)', () => {
  it('is exhausted when any turn-wide counter hits its limit', () => {
    expect(isBudgetExhausted(state({stepsUsed: budget.stepLimit}), budget)).toBe(true);
    expect(isBudgetExhausted(state({toolCallsUsed: budget.toolCallLimit}), budget)).toBe(true);
    expect(isBudgetExhausted(state({toolOnlyStepsUsed: budget.toolOnlyStepLimit}), budget)).toBe(true);
    expect(isBudgetExhausted(state({finishCause: 'length'}), budget)).toBe(true);
  });

  it('is not exhausted while counters remain', () => {
    expect(isBudgetExhausted(state({stepsUsed: budget.stepLimit - 1, toolCallsUsed: 0, toolOnlyStepsUsed: 0}), budget)).toBe(false);
  });

  it('enforces the global budget across slices (accumulated counters, never reset)', () => {
    // Simulate a prior slice that used 60 steps + 100 tool calls, then another slice.
    const accumulated = state({stepsUsed: 60, toolCallsUsed: 100, toolOnlyStepsUsed: 0});
    // One more slice of 6 steps would exceed the global step limit.
    expect(isBudgetExhausted(state({stepsUsed: accumulated.stepsUsed + 6}), budget)).toBe(true);
    // But the prior usage itself does not yet exhaust.
    expect(isBudgetExhausted(accumulated, budget)).toBe(false);
  });
});

describe('decideTerminalStatus', () => {
  type Row = {name: string; state: Partial<TurnExecutionState>; evidence: Partial<CompletionEvidence>; budgetExhausted: boolean; expected: 'complete' | 'aborted' | 'failed'};
  const rows: Row[] = [
    {name: 'normal stop with substantive answer', state: {finishCause: 'stop'}, evidence: evidence({sawToolCall: true, assistantText: 'Done.', lastToolOk: true}), budgetExhausted: false, expected: 'complete'},
    {name: 'first length finish (recovery disabled) -> failed', state: {finishCause: 'length'}, evidence: evidence({assistantText: 'partial'}), budgetExhausted: false, expected: 'failed'},
    {name: 'repeated length finish -> failed', state: {finishCause: 'length', lengthCreditUsed: true}, evidence: evidence({assistantText: 'partial'}), budgetExhausted: false, expected: 'failed'},
    {name: 'no remaining budget -> failed', state: {stepsUsed: budget.stepLimit}, evidence: evidence({assistantText: 'done'}), budgetExhausted: true, expected: 'failed'},
    {name: 'abort always wins', state: {aborted: true}, evidence: evidence({assistantText: 'done'}), budgetExhausted: false, expected: 'aborted'},
    {name: 'abort wins even when budget exhausted', state: {aborted: true, stepsUsed: budget.stepLimit}, evidence: evidence({assistantText: ''}), budgetExhausted: true, expected: 'aborted'},
    {name: 'failed last tool -> failed', state: {finishCause: 'stop'}, evidence: evidence({sawToolCall: true, assistantText: 'Done.', lastToolOk: false}), budgetExhausted: false, expected: 'failed'},
    {name: 'unresolved tool input error -> failed', state: {finishCause: 'stop'}, evidence: evidence({assistantText: 'retrying', unresolvedToolInputError: true}), budgetExhausted: false, expected: 'failed'},
    {name: 'error finish -> failed', state: {finishCause: 'error'}, evidence: evidence({assistantText: 'x'}), budgetExhausted: false, expected: 'failed'},
    {name: 'tools ran but no final answer -> failed', state: {finishCause: 'stop'}, evidence: evidence({sawToolCall: true, assistantText: '', lastToolOk: true}), budgetExhausted: false, expected: 'failed'},
    {name: 'no tools and no text -> failed', state: {finishCause: 'stop'}, evidence: evidence({assistantText: ''}), budgetExhausted: false, expected: 'failed'},
  ];
  for (const row of rows) {
    it(row.name, () => {
      expect(decideTerminalStatus(state(row.state), evidence(row.evidence), row.budgetExhausted)).toBe(row.expected);
    });
  }
});

describe('hasRemainingRecoveryBudget', () => {
  it('is true only when both steps and tool calls remain (length finish excluded)', () => {
    expect(hasRemainingRecoveryBudget(state({finishCause: 'length', stepsUsed: 0}), budget)).toBe(true);
    expect(hasRemainingRecoveryBudget(state({stepsUsed: budget.stepLimit}), budget)).toBe(false);
    expect(hasRemainingRecoveryBudget(state({toolCallsUsed: budget.toolCallLimit}), budget)).toBe(false);
  });
});

describe('toCompletionEvidence (Increment 3, safe)', () => {
  it('projects the turn-wide state into a bounded evidence object', () => {
    const s = state({finishCause: 'stop', validationOutcome: 'passed', validationKind: 'test', mutationCount: 2, validationAfterMutation: true, lengthCreditUsed: true, budgetBoundary: false});
    expect(toCompletionEvidence(s)).toEqual({
      validationOutcome: 'passed',
      validationKind: 'test',
      validationAfterMutation: true,
      mutationCount: 2,
      finishCause: 'stop',
      recoveryUsed: {length: true, rescue: false},
      budgetBoundary: false,
    });
  });

  it('omits validationKind when absent and reports absent/not_applicable outcomes', () => {
    expect(toCompletionEvidence(state({validationOutcome: 'absent'}))).not.toHaveProperty('validationKind');
    expect(toCompletionEvidence(state({validationOutcome: 'not_applicable'})).validationOutcome).toBe('not_applicable');
  });

  it('never carries raw commands, output, or credentials', () => {
    const s = state({finishCause: 'failed' as never, validationOutcome: 'failed'});
    const json = JSON.stringify(toCompletionEvidence(s));
    for (const forbidden of ['command', 'stdout', 'stderr', 'error', 'key', 'token', 'path']) {
      expect(json).not.toContain(forbidden);
    }
  });
});

describe('hasSatisfactoryTerminalOutcome', () => {
  it('is satisfied by a substantive answer with no known failure', () => {
    expect(hasSatisfactoryTerminalOutcome(state(), evidence({assistantText: 'Done.', lastToolOk: true}))).toBe(true);
  });

  it('is not satisfied by an empty answer or a failed tool', () => {
    expect(hasSatisfactoryTerminalOutcome(state(), evidence({assistantText: ''}))).toBe(false);
    expect(hasSatisfactoryTerminalOutcome(state(), evidence({assistantText: 'Done.', lastToolOk: false}))).toBe(false);
  });

  it('is satisfied (stops recovery) when aborted', () => {
    expect(hasSatisfactoryTerminalOutcome(state({aborted: true}), evidence({assistantText: ''}))).toBe(true);
  });
});

describe('recovery decisions (Increment 2: bounded, single-use)', () => {
  it('continues once on a length finish with budget remaining', () => {
    expect(decideLengthRecovery(state({finishCause: 'length'}), budget).action).toBe('continue');
  });

  it('declines length-continuation when not a length finish', () => {
    expect(decideLengthRecovery(state({finishCause: 'stop'}), budget).action).toBe('stop');
    expect(decideLengthRecovery(state({finishCause: 'tool-calls'}), budget).action).toBe('stop');
  });

  it('declines length-continuation when aborted', () => {
    expect(decideLengthRecovery(state({finishCause: 'length', aborted: true}), budget).action).toBe('stop');
  });

  it('declines length-continuation once the credit is used (repeated length terminates)', () => {
    expect(decideLengthRecovery(state({finishCause: 'length', lengthCreditUsed: true}), budget).action).toBe('stop');
  });

  it('declines length-continuation when step/tool budget is gone', () => {
    expect(decideLengthRecovery(state({finishCause: 'length', stepsUsed: budget.stepLimit}), budget).action).toBe('stop');
    expect(decideLengthRecovery(state({finishCause: 'length', toolCallsUsed: budget.toolCallLimit}), budget).action).toBe('stop');
  });

  it('declines length-continuation when a fresh passing validation already landed', () => {
    expect(decideLengthRecovery(state({finishCause: 'length', validationOutcome: 'passed'}), budget).action).toBe('stop');
  });

  it('continues rescue once near the tool-only boundary for a mutating request with no answer', () => {
    const s = state({finishCause: 'stop', toolOnlyStepsUsed: RESCUE_BOUNDARY});
    const ev = evidence({sawToolCall: true, assistantText: '', lastToolOk: true});
    expect(decideRescue(s, ev, budget, true).action).toBe('continue');
  });

  it('declines rescue when not near the boundary', () => {
    const s = state({finishCause: 'stop', toolOnlyStepsUsed: 0});
    expect(decideRescue(s, evidence({assistantText: '', sawToolCall: true}), budget, true).action).toBe('stop');
  });

  it('declines rescue for non-mutating requests', () => {
    const s = state({finishCause: 'stop', toolOnlyStepsUsed: RESCUE_BOUNDARY});
    expect(decideRescue(s, evidence({assistantText: '', sawToolCall: true}), budget, false).action).toBe('stop');
  });

  it('declines rescue once used, when aborted, or when a substantive answer exists', () => {
    const base = state({finishCause: 'stop', toolOnlyStepsUsed: RESCUE_BOUNDARY});
    expect(decideRescue({...base, rescueUsed: true}, evidence({assistantText: ''}), budget, true).action).toBe('stop');
    expect(decideRescue({...base, aborted: true}, evidence({assistantText: ''}), budget, true).action).toBe('stop');
    expect(decideRescue(base, evidence({assistantText: 'Done.'}), budget, true).action).toBe('stop');
  });
});
