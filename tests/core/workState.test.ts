import {describe, expect, it} from 'vitest';
import {createWorkState, deriveValidationOutcome, intentExpectsValidation, observeWorkToolEvent, seedCarriedGoalEvidence, taskProgressFromOutput, validationSummaryFromOutput, workStatePrompt, type WorkTaskProgress} from '../../src/core/agent/workState.js';

function passedSummary(text = 'tests passed') {
  return {kind: 'test', status: 'passed', summaryText: text, failedFiles: [], failedTests: [], diagnostics: [], rawOutputTruncated: false};
}
function failedSummary(text = 'tests failed') {
  return {kind: 'test', status: 'failed', summaryText: text, failedFiles: [], failedTests: ['suite'], diagnostics: [], rawOutputTruncated: false};
}

describe('work state', () => {
  it('records files and validation without raw tool output', () => {
    const state = createWorkState('add feature', 'implement', ['change code', 'test']);
    observeWorkToolEvent(state, {toolName: 'readFile', input: {path: 'src/a.ts'}, success: true});
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'src/a.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary('10 tests passed')}});
    expect(state.files).toEqual([{path: 'src/a.ts', action: 'modified'}]);
    expect(state.validations).toEqual([{command: 'npm test', status: 'passed', summary: '10 tests passed', kind: 'test'}]);
    expect(workStatePrompt(state)).toContain('<work_state>');
  });

  it('preserves an actionable edit blocker', () => {
    const state = createWorkState('fix', 'fix', []);
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'src/a.ts'}, success: false, output: {ok: false, error: 'stale text'}});
    expect(state.blockers[0]).toContain('src/a.ts');
    expect(state.nextAction).toContain('Read src/a.ts');
  });

  it('does NOT treat an arbitrary shell call as validation', () => {
    const state = createWorkState('set up env', 'implement', []);
    // An inspection command (no validationSummary because the classifier did not
    // mark it as a validation command) must not be recorded as validation.
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'ls -la'}, success: true, output: {ok: true, code: 0}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'echo hi'}, success: true, output: {ok: true, code: 0}});
    expect(state.validations).toEqual([]);
    expect(state.validationSeq).toBe(0);
  });

  it('credits direct execution of an artifact changed during this goal', () => {
    const state = createWorkState('implement the CLI', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'writeFile', input: {path: 'csv-query.js'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'node csv-query.js --help'}, success: true, output: {ok: true, code: 0}});
    expect(state.validations).toEqual([expect.objectContaining({command: 'node csv-query.js --help', status: 'passed', kind: 'generic'})]);
    expect(deriveValidationOutcome(state)).toBe('passed');
  });

  it('records a failed direct artifact execution and rejects masked or unrelated commands', () => {
    const state = createWorkState('implement the CLI', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'writeFile', input: {path: 'cli.py'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'python other.py'}, success: true, output: {ok: true, code: 0}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'python cli.py | tail -1'}, success: true, output: {ok: true, code: 0}});
    expect(state.validations).toEqual([]);

    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'python cli.py'}, success: false, output: {ok: false, code: 1}});
    expect(state.validations).toEqual([expect.objectContaining({command: 'python cli.py', status: 'failed'})]);
    expect(deriveValidationOutcome(state)).toBe('failed');
  });

  it('counts mutations and sequences validation', () => {
    const state = createWorkState('edit', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'writeFile', input: {path: 'b.ts'}, success: true, output: {ok: true}});
    expect(state.mutationCount).toBe(2);
    expect(state.mutationSeq).toBeGreaterThan(0);
  });
});

describe('deriveValidationOutcome', () => {
  it('marks a fresh passing validation as passed', () => {
    const state = createWorkState('add feature', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('passed');
  });

  it('marks the latest failed validation as failed', () => {
    const state = createWorkState('add feature', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: false, output: {ok: false, code: 1, validationSummary: failedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('failed');
  });

  it('marks a validation stale when a mutation happens afterwards', () => {
    const state = createWorkState('add feature', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    // A later edit invalidates the prior validation.
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    expect(deriveValidationOutcome(state)).toBe('stale');
    // Fresh again after a post-mutation validation.
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('passed');
  });

  it('reports absent when an implementation request never validated', () => {
    const state = createWorkState('add feature', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    expect(deriveValidationOutcome(state)).toBe('absent');
    expect(intentExpectsValidation('implement')).toBe(true);
  });

  it('reports not_applicable when the request does not call for validation', () => {
    const answerState = createWorkState('explain x', 'answer', []);
    expect(deriveValidationOutcome(answerState)).toBe('not_applicable');
    const reviewState = createWorkState('review the code', 'review', []);
    expect(deriveValidationOutcome(reviewState)).toBe('not_applicable');
    expect(intentExpectsValidation('answer')).toBe(false);
  });

  it('treats a pure test/run request validation on its own (no mutation -> not stale)', () => {
    const state = createWorkState('run the tests', 'test', []);
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: false, output: {ok: false, code: 1, validationSummary: failedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('failed');
  });
});

describe('validationSummaryFromOutput', () => {
  it('extracts a well-formed validation summary and rejects malformed shapes', () => {
    expect(validationSummaryFromOutput({validationSummary: passedSummary()})).toBeDefined();
    expect(validationSummaryFromOutput({validationSummary: {summaryText: 'no diagnostics'}})).toBeUndefined();
    expect(validationSummaryFromOutput({code: 1})).toBeUndefined();
    expect(validationSummaryFromOutput(undefined)).toBeUndefined();
  });
});

describe('taskProgressFromOutput', () => {
  it('parses bounded numeric counts from a successful writeTasks result', () => {
    expect(taskProgressFromOutput({ok: true, taskCount: 5, counts: {pending: 3, in_progress: 1, completed: 1}, summary: 'x'}, 7)).toEqual({total: 5, pending: 3, inProgress: 1, completed: 1, revision: 7});
  });

  it('treats a cleared list as all-zero progress', () => {
    expect(taskProgressFromOutput({ok: true, taskCount: 0, summary: 'Task list cleared.'}, 9)).toEqual({total: 0, pending: 0, inProgress: 0, completed: 0, revision: 9});
  });

  it('ignores failed, malformed, or partial outputs safely', () => {
    expect(taskProgressFromOutput({ok: false, error: 'nope'}, 1)).toBeUndefined();
    expect(taskProgressFromOutput(undefined, 1)).toBeUndefined();
    expect(taskProgressFromOutput('tasks: 3', 1)).toBeUndefined();
    expect(taskProgressFromOutput({ok: true}, 1)).toBeUndefined();
    expect(taskProgressFromOutput({ok: true, taskCount: 3}, 1)).toBeUndefined();
    expect(taskProgressFromOutput({ok: true, taskCount: 3, counts: {pending: 1}}, 1)).toBeUndefined();
    expect(taskProgressFromOutput({ok: true, taskCount: 'all', counts: {}}, 1)).toBeUndefined();
    expect(taskProgressFromOutput({ok: true, taskCount: 99_999, counts: {pending: 1, in_progress: 0, completed: 0}}, 1)).toBeUndefined();
  });

  it('never carries task titles or raw output', () => {
    const progress = taskProgressFromOutput({ok: true, taskCount: 1, counts: {pending: 1, in_progress: 0, completed: 0}, summary: 'Tasks: 1 pending.'}, 2);
    expect(JSON.stringify(progress)).not.toContain('summary');
    expect(JSON.stringify(progress)).not.toContain('title');
  });
});

describe('seedCarriedGoalEvidence (cross-physical-turn hydration)', () => {
  it('keeps demanding validation when edits from earlier turns lack it', () => {
    const state = createWorkState('fix it', 'fix', []);
    seedCarriedGoalEvidence(state, {mutationCount: 14, validationOutcome: 'stale'});
    expect(state.mutationCount).toBe(14);
    expect(deriveValidationOutcome(state)).toBe('absent');
    // A fresh validation this turn (no new edits) clears the carried debt.
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('passed');
    // New edits invalidate it again.
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    expect(deriveValidationOutcome(state)).toBe('stale');
    expect(state.mutationCount).toBe(15);
  });

  it('carries a passed outcome so an already-validated goal may finish with a summary-only turn', () => {
    const state = createWorkState('fix it', 'fix', []);
    seedCarriedGoalEvidence(state, {mutationCount: 3, validationOutcome: 'passed'});
    expect(deriveValidationOutcome(state)).toBe('passed');
    expect(state.carriedValidation).toEqual({status: 'passed'});
    // A fresh failing validation this turn supersedes the carried one.
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: false, output: {ok: false, code: 1, validationSummary: failedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('failed');
  });

  it('seeds carried task counts so an undeclared list still gates completion', () => {
    const state = createWorkState('do it', 'implement', []);
    seedCarriedGoalEvidence(state, {mutationCount: 0, validationOutcome: 'not_applicable', taskProgress: {total: 7, pending: 6, inProgress: 1, completed: 0, revision: 4}});
    expect(state.taskProgress).toMatchObject({total: 7, pending: 6, inProgress: 1});
    // Re-declaring all completed clears the gate.
    observeWorkToolEvent(state, {toolName: 'writeTasks', input: {tasks: []}, success: true, output: {ok: true, taskCount: 7, counts: {pending: 0, in_progress: 0, completed: 7}, summary: 'x'}});
    expect(state.taskProgress).toMatchObject({pending: 0, completed: 7});
  });

  it('is a no-op for a fresh goal (no carried evidence)', () => {
    const state = createWorkState('fresh', 'implement', []);
    seedCarriedGoalEvidence(state, {mutationCount: 0, validationOutcome: 'not_applicable'});
    expect(state.mutationSeq).toBe(0);
    expect(state.validationSeq).toBe(0);
    expect(state.carriedValidation).toBeUndefined();
    expect(state.taskProgress).toBeUndefined();
    expect(deriveValidationOutcome(state)).toBe('absent');
  });
});

describe('work state task progress (writeTasks observation)', () => {
  it('records pending/in-progress counts from a successful writeTasks event and keeps them across later reads', () => {
    const state = createWorkState('do the roadmap', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'writeTasks', input: {tasks: [{title: 'a'}, {title: 'b'}, {title: 'c'}, {title: 'd'}, {title: 'e'}]}, success: true, output: {ok: true, taskCount: 5, counts: {pending: 5, in_progress: 0, completed: 0}, summary: 'Tasks: 5 pending.'}});
    expect(state.taskProgress).toEqual({total: 5, pending: 5, inProgress: 0, completed: 0, revision: state.revision});
    const revision = state.revision;
    // A later read does not disturb the task evidence.
    observeWorkToolEvent(state, {toolName: 'readFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    expect(state.taskProgress).toMatchObject({total: 5, pending: 5, revision});
  });

  it('updates counts when the model re-declares the list and accepts an all-completed list', () => {
    const state = createWorkState('do the roadmap', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'writeTasks', input: {tasks: []}, success: true, output: {ok: true, taskCount: 2, counts: {pending: 1, in_progress: 1, completed: 0}, summary: 'x'}});
    expect(state.taskProgress).toMatchObject({pending: 1, inProgress: 1});
    observeWorkToolEvent(state, {toolName: 'writeTasks', input: {tasks: []}, success: true, output: {ok: true, taskCount: 2, counts: {pending: 0, in_progress: 0, completed: 2}, summary: 'x'}});
    expect(state.taskProgress).toMatchObject({pending: 0, inProgress: 0, completed: 2});
  });

  it('ignores failed and malformed writeTasks results without touching prior evidence', () => {
    const state = createWorkState('do the roadmap', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'writeTasks', input: {tasks: []}, success: true, output: {ok: true, taskCount: 1, counts: {pending: 1, in_progress: 0, completed: 0}, summary: 'x'}});
    const first: WorkTaskProgress = state.taskProgress!;
    observeWorkToolEvent(state, {toolName: 'writeTasks', input: {tasks: []}, success: false, output: {ok: false, error: 'Task 1: title cannot be empty.'}});
    observeWorkToolEvent(state, {toolName: 'writeTasks', input: {tasks: []}, success: true, output: {ok: true, summary: 'no counts'}});
    expect(state.taskProgress).toBe(first);
  });

  it('skips duplicate-skipped writeTasks events like any other duplicate', () => {
    const state = createWorkState('do the roadmap', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'writeTasks', success: true, output: {ok: true, taskCount: 1, counts: {pending: 1, in_progress: 0, completed: 0}}, duplicateSkipped: true});
    expect(state.taskProgress).toBeUndefined();
  });
});
