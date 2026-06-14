import {describe, expect, it} from 'vitest';
import {classifyRequestIntent, isActionRequest, isPlanOnlyRequest, isValidationRequest} from '../../src/core/goal/requestClassifier.js';
import {completionDecision, looksBlocked, looksIncomplete, toolLoopBudgetPrompt} from '../../src/core/goal/completionPolicy.js';
import {createSessionGoal, formatGoalStatus, observeGoalToolEvent} from '../../src/core/goal/sessionGoal.js';

describe('requestClassifier', () => {
  it('classifies plan-only requests without treating them as actions', () => {
    expect(isPlanOnlyRequest('create a plan for auth')).toBe(true);
    expect(isActionRequest('create a plan for auth')).toBe(false);
    expect(classifyRequestIntent('create a plan for auth')).toBe('plan');
  });

  it('classifies implementation and validation requests', () => {
    expect(isActionRequest('add password reset emails')).toBe(true);
    expect(classifyRequestIntent('fix login tests')).toBe('fix');
    expect(isValidationRequest('run npm test')).toBe(true);
    expect(classifyRequestIntent('run npm test')).toBe('test');
  });
});

describe('SessionGoal', () => {
  it('tracks touched files and validation commands from tool events', () => {
    const goal = createSessionGoal('add a feature', 1);
    observeGoalToolEvent(goal, {toolName: 'readFile', input: {path: 'src/a.ts'}, success: true}, 2);
    expect(goal.phase).toBe('inspecting');

    observeGoalToolEvent(goal, {toolName: 'editFile', input: {path: 'src/a.ts'}, success: true}, 3);
    expect(goal.phase).toBe('editing');
    expect(goal.touchedFiles).toEqual(['src/a.ts']);

    observeGoalToolEvent(goal, {toolName: 'bash', input: {command: 'npm test'}, success: true, output: {ok: true}}, 4);
    expect(goal.phase).toBe('validating');
    expect(goal.validationCommands).toEqual([{command: 'npm test', status: 'passed'}]);
    expect(formatGoalStatus(goal)).toContain('Goal: add a feature');
  });

  it('does not count duplicate skipped tool outputs as progress', () => {
    const goal = createSessionGoal('add a feature', 1);
    observeGoalToolEvent(goal, {toolName: 'editFile', input: {path: 'src/a.ts'}, success: true, duplicateSkipped: true}, 2);
    expect(goal.phase).toBe('starting');
    expect(goal.touchedFiles).toEqual([]);
  });
});

describe('completionDecision', () => {
  it('continues action requests after read-only inspection without mutation', () => {
    const goal = createSessionGoal('add a feature', 1);
    const decision = completionDecision({
      request: 'add a feature',
      goal,
      assistantText: 'I inspected the files.',
      sawReadOnlyTool: true,
      sawToolCall: true,
      mutatingToolSucceeded: false,
      validationToolSucceeded: false,
      validationToolFailed: false,
      editFileFailed: false,
    });
    expect(decision.needsActionContinuation).toBe(true);
    expect(decision.continuationPrompt).toContain('have not made the requested change');
  });

  it('continues validation requests until validation runs', () => {
    const goal = createSessionGoal('run tests', 1);
    const decision = completionDecision({
      request: 'run tests',
      goal,
      assistantText: 'I will run tests next.',
      sawReadOnlyTool: false,
      sawToolCall: false,
      mutatingToolSucceeded: false,
      validationToolSucceeded: false,
      validationToolFailed: false,
      editFileFailed: false,
    });
    expect(decision.needsValidationContinuation).toBe(true);
  });

  it('continues after validation fails in a changed task', () => {
    const goal = createSessionGoal('add a feature', 1);
    const decision = completionDecision({
      request: 'add a feature',
      goal,
      assistantText: 'Tests failed.',
      sawReadOnlyTool: true,
      sawToolCall: true,
      mutatingToolSucceeded: true,
      validationToolSucceeded: false,
      validationToolFailed: true,
      editFileFailed: false,
    });
    expect(decision.needsActionContinuation).toBe(true);
    expect(decision.continuationPrompt).toContain('Validation failed');
  });

  it('continues changed action requests until validation runs', () => {
    const goal = createSessionGoal('add a feature', 1);
    const decision = completionDecision({
      request: 'add a feature',
      goal,
      assistantText: 'Changed src/a.ts.',
      sawReadOnlyTool: true,
      sawToolCall: true,
      mutatingToolSucceeded: true,
      validationToolSucceeded: false,
      validationToolFailed: false,
      editFileFailed: false,
    });
    expect(decision.needsValidationContinuation).toBe(true);
    expect(decision.continuationPrompt).toContain('no validation has run');
  });

  it('stops validation continuation when the assistant reports a concrete blocker', () => {
    const goal = createSessionGoal('add a feature', 1);
    const decision = completionDecision({
      request: 'add a feature',
      goal,
      assistantText: 'Blocked: no practical validation exists for this documentation-only change.',
      sawReadOnlyTool: true,
      sawToolCall: true,
      mutatingToolSucceeded: true,
      validationToolSucceeded: false,
      validationToolFailed: false,
      editFileFailed: false,
    });
    expect(decision.needsValidationContinuation).toBe(false);
    expect(decision.assistantReportsBlocker).toBe(true);
  });

  it('detects incomplete assistant summaries and blockers', () => {
    expect(looksIncomplete('Remaining: run validation.')).toBe(true);
    expect(looksIncomplete('Tool slice reached; next action is writing App.vue.')).toBe(true);
    expect(looksBlocked('Blocked: missing dependency.')).toBe(true);
  });

  it('uses autonomous-friendly tool slice wording', () => {
    const prompt = toolLoopBudgetPrompt();
    expect(prompt).toMatch(/Haze can continue/i);
    expect(prompt).not.toContain('You cannot call tools now');
  });

  it('forbids announcement-style tool-call loops', () => {
    const prompt = toolLoopBudgetPrompt();
    expect(prompt).toMatch(/do not repeat yourself/i);
    expect(prompt).toMatch(/Let me|Now I/i);
  });
});
