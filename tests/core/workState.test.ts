import {describe, expect, it} from 'vitest';
import {createWorkState, observeWorkToolEvent, workStatePrompt} from '../../src/core/agent/workState.js';

describe('work state', () => {
  it('records files and validation without raw tool output', () => {
    const state = createWorkState('add feature', 'implement', ['change code', 'test']);
    observeWorkToolEvent(state, {toolName: 'readFile', input: {path: 'src/a.ts'}, success: true});
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'src/a.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'bash', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: {summaryText: '10 tests passed'}}});
    expect(state.files).toEqual([{path: 'src/a.ts', action: 'modified'}]);
    expect(state.validations).toEqual([{command: 'npm test', status: 'passed', summary: '10 tests passed'}]);
    expect(workStatePrompt(state)).toContain('<work_state>');
  });

  it('preserves an actionable edit blocker', () => {
    const state = createWorkState('fix', 'fix', []);
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'src/a.ts'}, success: false, output: {ok: false, error: 'stale text'}});
    expect(state.blockers[0]).toContain('src/a.ts');
    expect(state.nextAction).toContain('Read src/a.ts');
  });
});
