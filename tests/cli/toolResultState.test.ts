import {describe, expect, it} from 'vitest';
import {applyToolResultState, initialToolResultState} from '../../src/cli/commands/streaming/toolResultState.js';

describe('toolResultState', () => {
  it('requires a fresh read after a failed mutation', () => {
    const state = applyToolResultState(initialToolResultState(), {toolName: 'editFile', input: {path: 'a.ts'}, output: {ok: false}, ok: false});
    expect(state).toMatchObject({editRecoveryPath: 'a.ts', editRecoveryReadSatisfied: false});
  });

  it('marks edit recovery satisfied after a non-duplicate read of the same path', () => {
    const failed = applyToolResultState(initialToolResultState(), {toolName: 'editFile', input: {path: 'a.ts'}, output: {ok: false}, ok: false});
    const read = applyToolResultState(failed, {toolName: 'readFile', input: {path: 'a.ts'}, output: {content: 'x'}, ok: true});
    expect(read.editRecoveryReadSatisfied).toBe(true);
  });

  it('does not satisfy edit recovery from duplicate-skipped reads', () => {
    const failed = applyToolResultState(initialToolResultState(), {toolName: 'editFile', input: {path: 'a.ts'}, output: {ok: false}, ok: false});
    const read = applyToolResultState(failed, {toolName: 'readFile', input: {path: 'a.ts'}, output: {duplicateSkipped: true}, ok: true});
    expect(read.editRecoveryReadSatisfied).toBe(false);
  });

  it('records successful mutations and clears satisfied recovery for the same path', () => {
    const failed = applyToolResultState(initialToolResultState(), {toolName: 'editFile', input: {path: 'a.ts'}, output: {ok: false}, ok: false});
    const read = applyToolResultState(failed, {toolName: 'readFile', input: {path: 'a.ts'}, output: {content: 'x'}, ok: true});
    const edited = applyToolResultState(read, {toolName: 'editFile', input: {path: 'a.ts'}, output: {ok: true}, ok: true});
    expect(edited).toEqual({mutatingToolSucceeded: true, editRecoveryPath: undefined, editRecoveryReadSatisfied: false});
  });
});
