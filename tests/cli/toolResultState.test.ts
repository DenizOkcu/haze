import {describe, expect, it} from 'vitest';
import {applyStepToolResultState, applyToolResultState, initialToolResultState} from '../../src/cli/commands/streaming/toolResultState.js';

describe('toolResultState', () => {
  const staleFailure = {ok: false, recoveryTool: 'readFile'};

  it('requires a fresh read when a failed mutation explicitly requests one', () => {
    const state = applyToolResultState(initialToolResultState(), {toolName: 'editFile', input: {path: 'a.ts'}, output: staleFailure, ok: false});
    expect(state).toMatchObject({editRecoveryPath: 'a.ts', editRecoveryReadSatisfied: false});
  });

  it('does not force read-only recovery for failures fixed by changing arguments', () => {
    const state = applyToolResultState(initialToolResultState(), {toolName: 'writeFile', input: {path: 'a.ts'}, output: {ok: false, reasonCode: 'conflicting_write_modes'}, ok: false});
    expect(state).toEqual(initialToolResultState());
  });

  it('marks edit recovery satisfied after a non-duplicate read of the same normalized path', () => {
    const failed = applyToolResultState(initialToolResultState(), {toolName: 'editFile', input: {path: './a.ts'}, output: staleFailure, ok: false});
    const read = applyToolResultState(failed, {toolName: 'readFile', input: {path: 'a.ts'}, output: {content: 'x'}, ok: true});
    expect(read.editRecoveryReadSatisfied).toBe(true);
  });

  it('does not satisfy edit recovery from duplicate-skipped reads', () => {
    const failed = applyToolResultState(initialToolResultState(), {toolName: 'editFile', input: {path: 'a.ts'}, output: staleFailure, ok: false});
    const read = applyToolResultState(failed, {toolName: 'readFile', input: {path: 'a.ts'}, output: {duplicateSkipped: true}, ok: true});
    expect(read.editRecoveryReadSatisfied).toBe(false);
  });

  it('records successful mutations and clears satisfied recovery for the same path', () => {
    const failed = applyToolResultState(initialToolResultState(), {toolName: 'editFile', input: {path: 'a.ts'}, output: staleFailure, ok: false});
    const read = applyToolResultState(failed, {toolName: 'readFile', input: {path: 'a.ts'}, output: {content: 'x'}, ok: true});
    const edited = applyToolResultState(read, {toolName: 'editFile', input: {path: 'a.ts'}, output: {ok: true}, ok: true});
    expect(edited).toEqual({mutatingToolSucceeded: true, editRecoveryPath: undefined, editRecoveryReadSatisfied: false});
  });

  it('advances recovery from internally ordered SDK step content', () => {
    const failed = applyStepToolResultState(initialToolResultState(), [
      {type: 'tool-result', toolName: 'editFile', input: {path: 'a.ts'}, output: staleFailure},
    ]);
    const read = applyStepToolResultState(failed, [
      {type: 'tool-result', toolName: 'readFile', input: {path: './a.ts'}, output: {ok: true, content: 'x'}},
    ]);
    expect(read.editRecoveryReadSatisfied).toBe(true);
  });
});
