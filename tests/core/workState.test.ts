import {describe, expect, it} from 'vitest';
import {createWorkState, deriveValidationOutcome, intentExpectsValidation, observeWorkToolEvent, validationSummaryFromOutput, workStatePrompt} from '../../src/core/agent/workState.js';

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
    observeWorkToolEvent(state, {toolName: 'bash', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary('10 tests passed')}});
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

  it('does NOT treat an arbitrary bash call as validation', () => {
    const state = createWorkState('set up env', 'implement', []);
    // An inspection command (no validationSummary because the classifier did not
    // mark it as a validation command) must not be recorded as validation.
    observeWorkToolEvent(state, {toolName: 'bash', input: {command: 'ls -la'}, success: true, output: {ok: true, code: 0}});
    observeWorkToolEvent(state, {toolName: 'bash', input: {command: 'echo hi'}, success: true, output: {ok: true, code: 0}});
    expect(state.validations).toEqual([]);
    expect(state.validationSeq).toBe(0);
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
    observeWorkToolEvent(state, {toolName: 'bash', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('passed');
  });

  it('marks the latest failed validation as failed', () => {
    const state = createWorkState('add feature', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'bash', input: {command: 'npm test'}, success: false, output: {ok: false, code: 1, validationSummary: failedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('failed');
  });

  it('marks a validation stale when a mutation happens afterwards', () => {
    const state = createWorkState('add feature', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'bash', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    // A later edit invalidates the prior validation.
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    expect(deriveValidationOutcome(state)).toBe('stale');
    // Fresh again after a post-mutation validation.
    observeWorkToolEvent(state, {toolName: 'bash', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
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
    observeWorkToolEvent(state, {toolName: 'bash', input: {command: 'npm test'}, success: false, output: {ok: false, code: 1, validationSummary: failedSummary()}});
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
