import {isDuplicateSkippedOutput, toolInputField} from '../../../core/agent/toolResults.js';

const MUTATING_TOOLS = new Set(['editFile', 'replaceLines', 'writeFile']);

export interface ToolResultState {
  mutatingToolSucceeded: boolean;
  editRecoveryPath?: string;
  editRecoveryReadSatisfied: boolean;
}

export function initialToolResultState(): ToolResultState {
  return {mutatingToolSucceeded: false, editRecoveryReadSatisfied: false};
}

export function applyToolResultState(state: ToolResultState, event: {toolName: string; input: unknown; output: unknown; ok: boolean}): ToolResultState {
  const path = toolInputField(event.input, 'path');
  if (!event.ok && MUTATING_TOOLS.has(event.toolName)) {
    return {...state, editRecoveryPath: path, editRecoveryReadSatisfied: false};
  }
  if (event.ok && event.toolName === 'readFile' && path && path === state.editRecoveryPath && !isDuplicateSkippedOutput(event.output)) {
    return {...state, editRecoveryReadSatisfied: true};
  }
  if (event.ok && !isDuplicateSkippedOutput(event.output) && MUTATING_TOOLS.has(event.toolName)) {
    return {
      mutatingToolSucceeded: true,
      editRecoveryPath: !path || path === state.editRecoveryPath ? undefined : state.editRecoveryPath,
      editRecoveryReadSatisfied: !path || path === state.editRecoveryPath ? false : state.editRecoveryReadSatisfied,
    };
  }
  return state;
}

export function isMutatingToolName(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
}
