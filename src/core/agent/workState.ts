import type {RequestIntent} from '../goal/requestClassifier.js';

export type WorkFileAction = 'read' | 'created' | 'modified';
export type WorkValidationStatus = 'passed' | 'failed';

export interface WorkState {
  goal: string;
  intent: RequestIntent;
  successCriteria: string[];
  constraints: string[];
  decisions: Array<{decision: string; reason?: string}>;
  files: Array<{path: string; action: WorkFileAction; note?: string}>;
  validations: Array<{command: string; status: WorkValidationStatus; summary: string}>;
  blockers: string[];
  pending: string[];
  nextAction?: string;
  phase: string;
  revision: number;
}

export interface WorkToolEvent {
  toolName: string;
  input?: unknown;
  success: boolean;
  output?: unknown;
  duplicateSkipped?: boolean;
}

function inputString(input: unknown, key: string) {
  return typeof input === 'object' && input != null && key in input && typeof (input as Record<string, unknown>)[key] === 'string'
    ? (input as Record<string, string>)[key]
    : undefined;
}

function upsertFile(state: WorkState, path: string, action: WorkFileAction, note?: string) {
  const existing = state.files.find(file => file.path === path);
  if (existing) {
    if (action !== 'read') existing.action = action;
    if (note) existing.note = note;
  } else {
    state.files.push({path, action, ...(note ? {note} : {})});
  }
}

function outputOk(output: unknown, success: boolean) {
  return success && !(typeof output === 'object' && output != null && 'ok' in output && output.ok === false);
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

export function createWorkState(goal: string, intent: RequestIntent, successCriteria: string[]): WorkState {
  return {
    goal,
    intent,
    successCriteria: [...successCriteria],
    constraints: [],
    decisions: [],
    files: [],
    validations: [],
    blockers: [],
    pending: [],
    phase: 'starting',
    revision: 0,
  };
}

export function observeWorkToolEvent(state: WorkState, event: WorkToolEvent) {
  if (event.duplicateSkipped) return state;
  const ok = outputOk(event.output, event.success);
  const path = inputString(event.input, 'path');

  if (ok && path && ['listFiles', 'readFile', 'grep'].includes(event.toolName)) {
    if (event.toolName === 'readFile') upsertFile(state, path, 'read');
    state.phase = 'inspecting';
  }

  if (path && ['editFile', 'replaceLines', 'writeFile'].includes(event.toolName)) {
    if (ok) {
      upsertFile(state, path, event.toolName === 'writeFile' ? 'created' : 'modified');
      state.phase = 'editing';
      state.blockers = state.blockers.filter(blocker => !blocker.includes(path));
    } else {
      state.blockers = [...new Set([...state.blockers, `Edit failed for ${path}: ${outputSummary(event.output) || 'fresh read required'}`])];
      state.nextAction = `Read ${path}, then retry the edit with current content.`;
    }
  }

  if (event.toolName === 'bash') {
    const command = inputString(event.input, 'command');
    if (command) {
      const status: WorkValidationStatus = ok ? 'passed' : 'failed';
      const existing = state.validations.find(validation => validation.command === command);
      const summary = outputSummary(event.output);
      if (existing) Object.assign(existing, {status, summary});
      else state.validations.push({command, status, summary});
      state.phase = 'validating';
      if (!ok) state.blockers = [...new Set([...state.blockers, `Validation failed: ${command}`])];
    }
  }

  state.revision += 1;
  return state;
}

export function workStatePrompt(state: WorkState) {
  return `<work_state>\n${JSON.stringify(state)}\n</work_state>`;
}
