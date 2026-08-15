import {describe, expect, it} from 'vitest';
import {classifyRequestIntent, createSessionGoal, formatGoalStatus, isPlanOnlyRequest, malformedToolCallPrompt, observeGoalToolEvent, repeatedToolCallPrompt, toolLoopBudgetPrompt} from '../../../src/core/agent/goalPolicy.js';

describe('requestClassifier', () => {
  it('classifies plan-only requests without treating them as actions', () => {
    expect(isPlanOnlyRequest('create a plan for auth')).toBe(true);
    expect(classifyRequestIntent('create a plan for auth')).toBe('plan');
  });

  it('classifies implementation, fix, and validation requests', () => {
    expect(classifyRequestIntent('add password reset emails')).toBe('implement');
    expect(classifyRequestIntent('fix login tests')).toBe('fix');
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

    observeGoalToolEvent(goal, {toolName: 'bash', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: {kind: 'test', status: 'passed', summaryText: 'tests passed', failedFiles: [], failedTests: [], diagnostics: [], rawOutputTruncated: false}}}, 4);
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

describe('completionPrompts', () => {
  it('uses autonomous-friendly tool slice wording', () => {
    const prompt = toolLoopBudgetPrompt();
    expect(prompt).toMatch(/haze continues the active goal automatically/i);
    expect(prompt).toMatch(/progress checkpoint/i);
    expect(prompt).not.toContain('You cannot call tools now');
  });

  it('forbids announcement-style tool-call loops', () => {
    const prompt = toolLoopBudgetPrompt();
    expect(prompt).toMatch(/do not repeat yourself/i);
    expect(prompt).toMatch(/Let me|Now I/i);
  });

  it('steers repeated tool calls back to the model', () => {
    const prompt = repeatedToolCallPrompt(['readFile', 'readFile']);
    expect(prompt).toMatch(/already called readFile/i);
    expect(prompt).toMatch(/Do not call the same tool again/i);
    expect(prompt).toMatch(/existing tool result/i);
  });

  it('requires malformed writes to retry in bounded chunks', () => {
    const prompt = malformedToolCallPrompt('writeFile', 16_384);
    expect(prompt).toMatch(/retry it now/i);
    expect(prompt).toMatch(/append=true/i);
    expect(prompt).toContain('16384');
  });
});
