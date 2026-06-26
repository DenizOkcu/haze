import type {RequestIntent} from '../goal/requestClassifier.js';
import {toolInputField, toolOutputOk} from './toolResults.js';

export type WorkFileAction = 'read' | 'created' | 'modified';
export type WorkValidationStatus = 'pending' | 'passed' | 'failed';
export type WorkStatus = 'active' | 'needs-user' | 'blocked' | 'complete' | 'aborted';
export type WorkPhase = 'starting' | 'inspecting' | 'editing' | 'validating' | 'summarizing' | 'done';

export interface WorkState {
  id: string;
  goal: string;
  originalUserRequest: string;
  intent: RequestIntent;
  normalizedIntent: RequestIntent;
  successCriteria: string[];
  constraints: string[];
  decisions: Array<{decision: string; reason?: string}>;
  files: Array<{path: string; action: WorkFileAction; note?: string}>;
  touchedFiles: string[];
  validations: Array<{command: string; status: Exclude<WorkValidationStatus, 'pending'>; summary: string}>;
  validationCommands: Array<{command: string; status: WorkValidationStatus}>;
  blockers: string[];
  pending: string[];
  nextAction?: string;
  status: WorkStatus;
  phase: WorkPhase;
  blocker?: string;
  lastProgressAt: number;
  revision: number;
}

export interface WorkToolEvent {
  toolName: string;
  input?: unknown;
  success: boolean;
  output?: unknown;
  duplicateSkipped?: boolean;
}

function upsertFile(state: WorkState, path: string, action: WorkFileAction, note?: string) {
  const existing = state.files.find(file => file.path === path);
  if (existing) {
    if (action !== 'read') existing.action = action;
    if (note) existing.note = note;
  } else {
    state.files.push({path, action, ...(note ? {note} : {})});
  }
  if (action !== 'read' && !state.touchedFiles.includes(path)) state.touchedFiles.push(path);
}

function outputSummary(output: unknown) {
  if (typeof output !== 'object' || output == null) return '';
  if ('validationSummary' in output && typeof output.validationSummary === 'object' && output.validationSummary != null && 'summaryText' in output.validationSummary) {
    return String(output.validationSummary.summaryText);
  }
  if ('error' in output && typeof output.error === 'string') return output.error;
  if ('code' in output) return `exit ${String(output.code)}`;
  return '';
}

function upsertValidation(state: WorkState, command: string, status: Exclude<WorkValidationStatus, 'pending'>, summary: string) {
  const existing = state.validations.find(validation => validation.command === command);
  if (existing) Object.assign(existing, {status, summary});
  else state.validations.push({command, status, summary});

  const existingCommand = state.validationCommands.find(item => item.command === command);
  if (existingCommand) existingCommand.status = status;
  else state.validationCommands.push({command, status});
}

export function createWorkState(goal: string, intent: RequestIntent, successCriteria: string[], now = Date.now()): WorkState {
  return {
    id: `goal-${now}-${Math.random().toString(36).slice(2)}`,
    goal,
    originalUserRequest: goal,
    intent,
    normalizedIntent: intent,
    successCriteria: [...successCriteria],
    constraints: [],
    decisions: [],
    files: [],
    touchedFiles: [],
    validations: [],
    validationCommands: [],
    blockers: [],
    pending: [],
    status: 'active',
    phase: 'starting',
    lastProgressAt: now,
    revision: 0,
  };
}

export function observeWorkToolEvent(state: WorkState, event: WorkToolEvent, now = Date.now()) {
  if (event.duplicateSkipped) return state;
  const ok = toolOutputOk(event.output, event.success);
  const path = toolInputField(event.input, 'path');

  if (ok && path && ['listFiles', 'readFile', 'grep'].includes(event.toolName)) {
    if (event.toolName === 'readFile') upsertFile(state, path, 'read');
    if (state.phase !== 'editing' && state.phase !== 'validating') state.phase = 'inspecting';
    state.lastProgressAt = now;
  }

  if (path && ['editFile', 'replaceLines', 'writeFile'].includes(event.toolName)) {
    if (ok) {
      upsertFile(state, path, event.toolName === 'writeFile' ? 'created' : 'modified');
      state.phase = 'editing';
      state.lastProgressAt = now;
      state.blockers = state.blockers.filter(blocker => !blocker.includes(path));
      if (state.blocker?.includes(path)) state.blocker = undefined;
    } else {
      state.blocker = `File edit failed for ${path}; recovery read is required before retry.`;
      state.blockers = [...new Set([...state.blockers, `Edit failed for ${path}: ${outputSummary(event.output) || 'fresh read required'}`])];
      state.nextAction = `Read ${path}, then retry the edit with current content.`;
    }
  }

  if (event.toolName === 'bash') {
    const command = toolInputField(event.input, 'command');
    if (command) {
      const status: Exclude<WorkValidationStatus, 'pending'> = ok ? 'passed' : 'failed';
      const summary = outputSummary(event.output);
      upsertValidation(state, command, status, summary);
      state.phase = 'validating';
      state.lastProgressAt = now;
      if (!ok) {
        state.blocker = `Validation command failed: ${command}`;
        state.blockers = [...new Set([...state.blockers, `Validation failed: ${command}`])];
      }
    }
  }

  state.revision += 1;
  return state;
}

export function workStatePrompt(state: WorkState) {
  return `<work_state>\n${JSON.stringify(state)}\n</work_state>`;
}
