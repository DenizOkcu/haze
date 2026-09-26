import {describe, expect, it} from 'vitest';
import {assessCompletionReadiness} from '../../src/core/agent/completionController.js';
import {createSessionGoal} from '../../src/core/agent/goalPolicy.js';
import {deriveValidationOutcome, observeWorkToolEvent, seedCarriedGoalEvidence, unresolvedFailedCheckIds, type WorkState} from '../../src/core/agent/workState.js';

const summary = (kind: 'test' | 'build' | 'generic', status: 'passed' | 'failed') => ({
  kind, status, summaryText: `${kind} ${status}`, failedFiles: [], failedTests: [], diagnostics: [], rawOutputTruncated: false,
});

function check(state: WorkState, command: string, kind: 'test' | 'build' | 'generic', status: 'passed' | 'failed') {
  observeWorkToolEvent(state, {toolName: 'shell', input: {command}, success: status === 'passed', output: {ok: status === 'passed', validationSummary: summary(kind, status)}});
}

function gate(state: WorkState) {
  return assessCompletionReadiness({
    aborted: false, intent: state.normalizedIntent, mutationCount: state.mutationCount,
    validationOutcome: deriveValidationOutcome(state), taskProgress: state.taskProgress,
  }, {lastToolOk: true, unresolvedToolInputError: false});
}

describe('Model steering replay', () => {
  it('keeps failed backend tests and open tasks across a budget boundary until the same check passes', () => {
    const request = 'make the local models run through a Koa API and run tests';
    const first = createSessionGoal(request);
    expect(first.intent).toBe('implement');
    observeWorkToolEvent(first, {toolName: 'writeFile', input: {path: 'api/src/app.ts'}, success: true, output: {ok: true}});
    check(first, 'cd api && npm test', 'test', 'failed');
    observeWorkToolEvent(first, {toolName: 'writeTasks', input: {}, success: true, output: {ok: true, taskCount: 3, counts: {pending: 1, in_progress: 1, completed: 1}}});
    expect(gate(first)).toBe('pending_tasks');

    const resumed = createSessionGoal(request);
    seedCarriedGoalEvidence(resumed, {mutationCount: first.mutationCount, validationOutcome: deriveValidationOutcome(first), validationKind: 'test', taskProgress: first.taskProgress, failedCheckIds: unresolvedFailedCheckIds(first)});
    observeWorkToolEvent(resumed, {toolName: 'editFile', input: {path: 'api/src/app.ts'}, success: true, output: {ok: true}});
    check(resumed, 'npm --prefix api test', 'test', 'passed');
    observeWorkToolEvent(resumed, {toolName: 'writeTasks', input: {}, success: true, output: {ok: true, taskCount: 3, counts: {pending: 0, in_progress: 0, completed: 3}}});
    expect(unresolvedFailedCheckIds(resumed)).toEqual([]);
    expect(gate(resumed)).toBe('ready');
  });

  it('rejects a frontend final with completed tasks while its build remains red', () => {
    const state = createSessionGoal('build a React frontend with two user flows');
    expect(state.intent).toBe('implement');
    observeWorkToolEvent(state, {toolName: 'writeFile', input: {path: 'frontend/src/App.tsx'}, success: true, output: {ok: true}});
    check(state, 'cd frontend && npm run build', 'build', 'failed');
    check(state, 'npm --prefix frontend test', 'test', 'passed');
    observeWorkToolEvent(state, {toolName: 'writeTasks', input: {}, success: true, output: {ok: true, taskCount: 5, counts: {pending: 0, in_progress: 0, completed: 5}}});
    expect(gate(state)).toBe('validation_failed');
    check(state, 'npm --prefix frontend run build', 'build', 'passed');
    expect(gate(state)).toBe('ready');
  });

  it('does not let an unknown mutating request finish with utility-only checks after a failed build', () => {
    const state = createSessionGoal('please improve usability');
    expect(state.intent).toBe('unknown');
    observeWorkToolEvent(state, {toolName: 'writeFile', input: {path: 'frontend/src/App.tsx'}, success: true, output: {ok: true}});
    expect(gate(state)).toBe('validation_absent_after_mutation');
    check(state, 'npm run build', 'build', 'failed');
    check(state, 'node utility-check.js', 'generic', 'passed');
    expect(gate(state)).toBe('validation_failed');
  });
});
