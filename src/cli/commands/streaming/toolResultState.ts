import {isDuplicateSkippedOutput, requiresReadFileRecovery, toolInputField, toolOutputOk} from '../../../core/agent/toolResults.js';
import {workspacePathKey} from '../../../utils/path.js';

const MUTATING_TOOLS = new Set(['editFile', 'replaceLines', 'writeFile']);

function samePath(first: string | undefined, second: string | undefined): boolean {
  return first != null && second != null && workspacePathKey(first) === workspacePathKey(second);
}

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
  if (!event.ok && MUTATING_TOOLS.has(event.toolName) && path && requiresReadFileRecovery(event.output)) {
    return {...state, editRecoveryPath: path, editRecoveryReadSatisfied: false};
  }
  if (event.ok && event.toolName === 'readFile' && samePath(path, state.editRecoveryPath) && !isDuplicateSkippedOutput(event.output)) {
    return {...state, editRecoveryReadSatisfied: true};
  }
  if (event.ok && !isDuplicateSkippedOutput(event.output) && MUTATING_TOOLS.has(event.toolName)) {
    const clearsRecovery = !path || samePath(path, state.editRecoveryPath);
    return {
      mutatingToolSucceeded: true,
      editRecoveryPath: clearsRecovery ? undefined : state.editRecoveryPath,
      editRecoveryReadSatisfied: clearsRecovery ? false : state.editRecoveryReadSatisfied,
    };
  }
  return state;
}

/**
 * Update recovery state from the SDK's internally ordered step content. This
 * runs in onStepEnd, before prepareStep can start the next model request, so a
 * fast provider cannot outrun state updates queued on the public stream.
 */
export function applyStepToolResultState(state: ToolResultState, content: readonly unknown[]): ToolResultState {
  let next = state;
  for (const part of content) {
    if (typeof part !== 'object' || part == null || !('type' in part)) continue;
    const value = part as Record<string, unknown>;
    if (value.type === 'tool-result' && typeof value.toolName === 'string') {
      next = applyToolResultState(next, {toolName: value.toolName, input: value.input, output: value.output, ok: toolOutputOk(value.output, true)});
    } else if (value.type === 'tool-error' && typeof value.toolName === 'string') {
      next = applyToolResultState(next, {toolName: value.toolName, input: value.input, output: value.error, ok: false});
    }
  }
  return next;
}
