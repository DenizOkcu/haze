import {describe, expect, it} from 'vitest';
import {
  assessCompletionReadiness,
  classifyTerminalOutcome,
  createTurnExecutionState,
  decideGoalContinuation,
  decideLengthRecovery,
  decideRescue,
  decideTerminalStatus,
  describeCompletionReadiness,
  goalContinuationRecoverable,
  goalProgressSignature,
  hasSatisfactoryTerminalOutcome,
  hasRemainingRecoveryBudget,
  isBudgetExhausted,
  normalizeFinishReason,
  recordGoalContinuation,
  rescueEligibleRequest,
  RESCUE_BOUNDARY,
  toCompletionEvidence,
  type CompletionEvidence,
  type TurnExecutionState,
} from '../../src/core/agent/completionController.js';
import {mainTurnBudget} from '../../src/core/agent/budgets.js';

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
      recoveryUsed: {length: true, rescue: false, goal: 0},
      budgetBoundary: false,
    });
  });

  it('projects current-turn task counts and goal-continuation usage', () => {
    const s = state({finishCause: 'stop', taskProgress: {total: 5, pending: 0, inProgress: 0, completed: 5, revision: 3}, goalContinuationsUsed: 2});
    expect(toCompletionEvidence(s)).toMatchObject({
      taskProgress: {total: 5, pending: 0, inProgress: 0, completed: 5},
      recoveryUsed: {length: false, rescue: false, goal: 2},
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

  it('is not satisfied by a substantive answer while declared tasks remain or validation is missing after edits', () => {
    expect(hasSatisfactoryTerminalOutcome(state({taskProgress: {total: 5, pending: 3, inProgress: 2, completed: 0, revision: 1}}), evidence({assistantText: 'Next unfinished action: wire the tool.'}))).toBe(false);
    expect(hasSatisfactoryTerminalOutcome(state({intent: 'implement', mutationCount: 1, validationOutcome: 'absent'}), evidence({assistantText: 'Done.'}))).toBe(false);
  });

  it('is satisfied (stops recovery) when aborted', () => {
    expect(hasSatisfactoryTerminalOutcome(state({aborted: true}), evidence({assistantText: ''}))).toBe(true);
  });
});

describe('assessCompletionReadiness (Cycle 1)', () => {
  it('reproduces the roadmap failure: substantive text plus five pending tasks is not ready', () => {
    const s = state({intent: 'implement', taskProgress: {total: 5, pending: 5, inProgress: 0, completed: 0, revision: 2}});
    const readiness = assessCompletionReadiness(s, evidence({assistantText: 'Next unfinished action: implement the tool.', sawToolCall: true, lastToolOk: true}));
    expect(readiness).toBe('pending_tasks');
    expect(decideTerminalStatus(s, evidence({assistantText: 'Next unfinished action: implement the tool.', sawToolCall: true, lastToolOk: true}), false)).toBe('failed');
  });

  it('treats all-completed and cleared task lists as ready', () => {
    expect(assessCompletionReadiness(state({taskProgress: {total: 3, pending: 0, inProgress: 0, completed: 3, revision: 4}}), evidence({lastToolOk: true}))).toBe('ready');
    expect(assessCompletionReadiness(state({taskProgress: {total: 0, pending: 0, inProgress: 0, completed: 0, revision: 4}}), evidence({lastToolOk: true}))).toBe('ready');
  });

  it('enforces intent-sensitive validation policy only after mutations', () => {
    // implement/fix/test with a mutation and no validation -> not ready.
    expect(assessCompletionReadiness(state({intent: 'implement', mutationCount: 1, validationOutcome: 'absent'}), evidence({lastToolOk: true}))).toBe('validation_absent_after_mutation');
    // No mutation: an honest answer without validation stays ready.
    expect(assessCompletionReadiness(state({intent: 'implement', mutationCount: 0, validationOutcome: 'absent'}), evidence({lastToolOk: true}))).toBe('ready');
    // Stale and failed validations block implement turns.
    expect(assessCompletionReadiness(state({intent: 'fix', mutationCount: 2, validationOutcome: 'stale'}), evidence({lastToolOk: true}))).toBe('validation_stale');
    expect(assessCompletionReadiness(state({intent: 'fix', mutationCount: 1, validationOutcome: 'failed'}), evidence({lastToolOk: true}))).toBe('validation_failed');
    // A fresh passing validation after the latest mutation is ready.
    expect(assessCompletionReadiness(state({intent: 'fix', mutationCount: 1, validationOutcome: 'passed'}), evidence({lastToolOk: true}))).toBe('ready');
  });

  it('never demands validation for plan/review/answer turns', () => {
    for (const intent of ['plan', 'review', 'answer'] as const) {
      expect(assessCompletionReadiness(state({intent, mutationCount: 0, validationOutcome: 'not_applicable'}), evidence({lastToolOk: true}))).toBe('ready');
    }
  });

  it('prefers hard failure reasons over task/validation evidence', () => {
    expect(assessCompletionReadiness(state({aborted: true}), evidence({lastToolOk: false}))).toBe('aborted');
    expect(assessCompletionReadiness(state({taskProgress: {total: 2, pending: 2, inProgress: 0, completed: 0, revision: 1}}), evidence({unresolvedToolInputError: true}))).toBe('unresolved_tool_input');
    expect(assessCompletionReadiness(state({taskProgress: {total: 2, pending: 2, inProgress: 0, completed: 0, revision: 1}}), evidence({lastToolOk: false}))).toBe('tool_failure');
  });

  it('describes readiness results with safe, bounded wording', () => {
    expect(describeCompletionReadiness('pending_tasks', {total: 5, pending: 4, inProgress: 1, completed: 0, revision: 1})).toContain('5 declared tasks still pending');
    expect(describeCompletionReadiness('validation_stale')).toContain('after the latest validation');
    expect(describeCompletionReadiness('ready')).toContain('complete');
    expect(JSON.stringify(describeCompletionReadiness('validation_failed'))).not.toMatch(/command|stdout|secret/);
  });
});

describe('recovery decisions (Increment 2: bounded, single-use)', () => {
  it('rescue eligibility covers every deliverable-bearing intent, including test orchestration (F-04)', () => {
    expect(rescueEligibleRequest('implement')).toBe(true);
    expect(rescueEligibleRequest('fix')).toBe(true);
    expect(rescueEligibleRequest('test')).toBe(true);
    expect(rescueEligibleRequest('review')).toBe(false);
    expect(rescueEligibleRequest('plan')).toBe(false);
    expect(rescueEligibleRequest('answer')).toBe(false);
    expect(rescueEligibleRequest('unknown')).toBe(false);
  });

  it('continues rescue for a test-orchestration request near the boundary (F-04)', () => {
    const s = state({finishCause: 'stop', toolOnlyStepsUsed: RESCUE_BOUNDARY});
    const ev = evidence({sawToolCall: true, assistantText: '', lastToolOk: true});
    expect(decideRescue(s, ev, budget, rescueEligibleRequest('test')).action).toBe('continue');
    expect(decideRescue(s, ev, budget, rescueEligibleRequest('answer')).action).toBe('stop');
  });
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

describe('decideGoalContinuation (Cycle 2: bounded, progress-guarded)', () => {
  const finalText = evidence({sawToolCall: true, assistantText: 'Next unfinished action: wire the tool.', lastToolOk: true});
  const pendingTasks = {total: 5, pending: 5, inProgress: 0, completed: 0, revision: 2};

  it('continues after a premature voluntary final while tasks remain', () => {
    const decision = decideGoalContinuation(state({finishCause: 'stop', intent: 'implement', taskProgress: pendingTasks}), finalText, budget);
    expect(decision.action).toBe('continue');
    expect(decision.pause).toBeUndefined();
  });

  it('continues for recoverable validation reasons and not for hard failures', () => {
    for (const readiness of ['pending_tasks', 'validation_failed', 'validation_stale', 'validation_absent_after_mutation'] as const) {
      expect(goalContinuationRecoverable(readiness)).toBe(true);
    }
    for (const readiness of ['ready', 'tool_failure', 'unresolved_tool_input', 'aborted'] as const) {
      expect(goalContinuationRecoverable(readiness)).toBe(false);
    }
    expect(decideGoalContinuation(state({finishCause: 'stop', intent: 'implement', mutationCount: 1, validationOutcome: 'absent'}), evidence({sawToolCall: true, assistantText: 'Wrote the file.', lastToolOk: true}), budget).action).toBe('continue');
    expect(decideGoalContinuation(state({finishCause: 'stop', intent: 'implement', taskProgress: pendingTasks}), evidence({sawToolCall: true, assistantText: 'Done.', lastToolOk: false}), budget).action).toBe('stop');
  });

  it('allows only one focused validation-repair continuation', () => {
    const s = state({finishCause: 'stop', intent: 'implement', mutationCount: 1, validationOutcome: 'absent'});
    const first = decideGoalContinuation(s, evidence({sawToolCall: true, assistantText: 'Done.', lastToolOk: true}), budget);
    expect(first).toMatchObject({action: 'continue', slice: {steps: 3, toolCalls: 3}});
    recordGoalContinuation(s);
    s.validationContinuationUsed = true;
    // More mutation activity cannot reopen another evidence-repair slice.
    s.mutationCount += 1;
    expect(decideGoalContinuation(s, evidence({sawToolCall: true, assistantText: 'Done again.', lastToolOk: true}), budget).action).toBe('stop');
  });

  it('stops (checkpoint is the caller\'s decision) when ready, aborted, empty-text, or a non-recoverable finish', () => {
    expect(decideGoalContinuation(state({finishCause: 'stop'}), evidence({assistantText: 'Done.', lastToolOk: true}), budget).action).toBe('stop');
    expect(decideGoalContinuation(state({finishCause: 'stop', aborted: true, taskProgress: pendingTasks}), finalText, budget).action).toBe('stop');
    expect(decideGoalContinuation(state({finishCause: 'stop', taskProgress: pendingTasks}), evidence({sawToolCall: true, assistantText: '', lastToolOk: true}), budget).action).toBe('stop');
    expect(decideGoalContinuation(state({finishCause: 'error', taskProgress: pendingTasks}), finalText, budget).action).toBe('stop');
    expect(decideGoalContinuation(state({finishCause: 'content-filter', taskProgress: pendingTasks}), finalText, budget).action).toBe('stop');
  });

  it('classifies budget-boundary tool-calls finishes as recoverable-incomplete, not silent failures', () => {
    // The reproduced field failure: step/tool budget exhaustion ends the stream
    // with finishCause 'tool-calls' while tasks remain — recoverable, even with
    // the global budget fully spent.
    const s = state({finishCause: 'tool-calls', intent: 'implement', stepsUsed: budget.stepLimit, toolCallsUsed: budget.toolCallLimit, taskProgress: pendingTasks});
    const ev = evidence({sawToolCall: true, assistantText: 'Next unfinished action remains.', lastToolOk: true});
    expect(classifyTerminalOutcome(s, ev)).toBe('recoverable-incomplete');
    // No same-turn budget remains, so in-turn continuation declines and the
    // caller must emit an incomplete-goal checkpoint.
    expect(decideGoalContinuation(s, ev, budget).action).toBe('stop');
  });

  it('classifies terminal outcomes against the logical goal', () => {
    const ready = state({finishCause: 'stop', intent: 'implement', mutationCount: 1, validationOutcome: 'passed'});
    expect(classifyTerminalOutcome(ready, evidence({assistantText: 'Done.', lastToolOk: true}))).toBe('goal-complete');
    // Ready evidence but no answer, or a non-stop finish, is not goal-complete.
    expect(classifyTerminalOutcome(ready, evidence({assistantText: '', lastToolOk: true}))).toBe('hard-blocked');
    expect(classifyTerminalOutcome({...ready, finishCause: 'unknown'}, evidence({assistantText: 'Done.', lastToolOk: true}))).toBe('hard-blocked');
    // Hard failures stay terminal.
    expect(classifyTerminalOutcome(state({finishCause: 'stop', taskProgress: pendingTasks}), evidence({assistantText: 'Done.', lastToolOk: false}))).toBe('hard-blocked');
    expect(classifyTerminalOutcome(state({aborted: true}), evidence({assistantText: ''}))).toBe('user-aborted');
    // Recoverable finishes include length and unknown.
    expect(classifyTerminalOutcome(state({finishCause: 'length', intent: 'implement', mutationCount: 1, validationOutcome: 'stale'}), evidence({assistantText: 'partial', lastToolOk: true}))).toBe('recoverable-incomplete');
    expect(classifyTerminalOutcome(state({finishCause: 'unknown', taskProgress: pendingTasks}), evidence({assistantText: 'x', lastToolOk: true}))).toBe('recoverable-incomplete');
  });

  it('declines in-turn continuation when the global budget is exhausted (checkpoint path)', () => {
    const decision = decideGoalContinuation(state({finishCause: 'stop', intent: 'implement', stepsUsed: budget.stepLimit, taskProgress: pendingTasks}), finalText, budget);
    expect(decision.action).toBe('stop');
    expect(decision.pause).toBeUndefined();
  });

  it('allows one corrective nudge with no progress, then declines in-turn (checkpoint path)', () => {
    const s = state({finishCause: 'stop', intent: 'implement', taskProgress: pendingTasks});
    // First continuation issued at this progress signature.
    recordGoalContinuation(s);
    expect(s.goalContinuationsUsed).toBe(1);
    expect(s.goalContinuationCorrectiveUsed).toBe(false);
    // No progress: the next stop is still allowed to continue (the corrective nudge).
    expect(decideGoalContinuation(s, finalText, budget).action).toBe('continue');
    recordGoalContinuation(s);
    expect(s.goalContinuationCorrectiveUsed).toBe(true);
    // Still no progress: stop — the goal supervisor\'s no-progress guard takes over.
    expect(decideGoalContinuation(s, finalText, budget).action).toBe('stop');
  });

  it('keeps allowing cycles while measurable progress continues', () => {
    const s = state({finishCause: 'stop', intent: 'implement', taskProgress: pendingTasks});
    recordGoalContinuation(s);
    // Progress: a new mutation and an updated task list.
    s.mutationCount += 1;
    s.taskProgress = {total: 5, pending: 4, inProgress: 1, completed: 0, revision: 3};
    expect(goalProgressSignature(s)).not.toBe(s.goalContinuationProgress);
    expect(decideGoalContinuation(s, finalText, budget).action).toBe('continue');
    recordGoalContinuation(s);
    expect(s.goalContinuationCorrectiveUsed).toBe(false);
    // More mutation activity without a task/validation outcome change is churn,
    // not measurable progress (edit→revert must not keep the loop alive).
    s.mutationCount += 1;
    recordGoalContinuation(s);
    expect(s.goalContinuationCorrectiveUsed).toBe(true);
  });

  it('never resets budgets or continuation counters (state is turn-wide)', () => {
    const s = state({finishCause: 'stop', intent: 'implement', stepsUsed: 10, toolCallsUsed: 20, taskProgress: pendingTasks});
    recordGoalContinuation(s);
    recordGoalContinuation(s);
    expect(s.stepsUsed).toBe(10);
    expect(s.toolCallsUsed).toBe(20);
    expect(s.goalContinuationsUsed).toBe(2);
  });
});
