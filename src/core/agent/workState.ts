import type {RequestIntent} from '../goal/requestClassifier.js';
import {isValidationSummary, type ValidationKind, type ValidationSummary} from '../../llm/toolResultTypes.js';
import {toolInputField, toolOutputOk} from './toolResults.js';

export type WorkFileAction = 'read' | 'created' | 'modified';
export type WorkValidationStatus = 'pending' | 'passed' | 'failed';
export type WorkStatus = 'active' | 'needs-user' | 'blocked' | 'complete' | 'aborted';
export type WorkPhase = 'starting' | 'inspecting' | 'editing' | 'validating' | 'summarizing' | 'done';

/**
 * Derived validation outcome for a turn, used as bounded completion evidence.
 *  - `passed`: a classifier-confirmed validation passed after the latest mutation.
 *  - `failed`: a validation failed and is the most recent result.
 *  - `stale`: a validation ran but predates the latest mutation (no longer trustworthy).
 *  - `absent`: validation was expected for this request but never ran.
 *  - `not_applicable`: the request does not call for validation (answer/review/plan).
 */
export type ValidationOutcome = 'passed' | 'failed' | 'stale' | 'absent' | 'not_applicable';

/** Request intents where a missing validation is itself meaningful evidence. */
export function intentExpectsValidation(intent: RequestIntent): boolean {
  return intent === 'implement' || intent === 'fix' || intent === 'test';
}

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
  validations: Array<{command: string; status: Exclude<WorkValidationStatus, 'pending'>; summary: string; kind?: ValidationKind}>;
  validationCommands: Array<{command: string; status: WorkValidationStatus}>;
  /** Number of successful workspace mutations observed this turn. */
  mutationCount: number;
  /** Monotonic sequence number of the latest successful mutation (0 = none). */
  mutationSeq: number;
  /** Monotonic sequence number of the latest validation (0 = none). */
  validationSeq: number;
  /** Single source of truth for blockers; the most recent entry is the current one (CR-023). */
  blockers: string[];
  pending: string[];
  nextAction?: string;
  status: WorkStatus;
  phase: WorkPhase;
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

function upsertValidation(state: WorkState, command: string, status: Exclude<WorkValidationStatus, 'pending'>, summary: string, kind: ValidationKind | undefined) {
  const existing = state.validations.find(validation => validation.command === command);
  if (existing) Object.assign(existing, {status, summary, ...(kind ? {kind} : {})});
  else state.validations.push({command, status, summary, ...(kind ? {kind} : {})});

  const existingCommand = state.validationCommands.find(item => item.command === command);
  if (existingCommand) existingCommand.status = status;
  else state.validationCommands.push({command, status});
}

/** Extract a classifier-confirmed validation summary from a tool output, if any. */
export function validationSummaryFromOutput(output: unknown): ValidationSummary | undefined {
  if (typeof output !== 'object' || output == null) return undefined;
  const candidate = (output as {validationSummary?: unknown}).validationSummary;
  return isValidationSummary(candidate) ? candidate : undefined;
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
    mutationCount: 0,
    mutationSeq: 0,
    validationSeq: 0,
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
  // Monotonic turn-wide clock. mutationSeq/validationSeq snapshot this value so
  // a validation that predates the latest mutation can be marked stale.
  const seq = state.revision + 1;

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
      state.mutationCount += 1;
      state.mutationSeq = seq;
    } else {
      state.blockers = [...new Set([...state.blockers, `Edit failed for ${path}: ${outputSummary(event.output) || 'fresh read required'}`])];
      state.nextAction = `Read ${path}, then retry the edit with current content.`;
    }
  }

  // Only a classifier-confirmed bash command is a validation step. An arbitrary
  // shell call (inspection, mkdir, echo) is process work, not validation; the
  // bash tool embeds a `validationSummary` exactly when the classifier says so.
  if (event.toolName === 'bash') {
    const command = toolInputField(event.input, 'command');
    const summary = validationSummaryFromOutput(event.output);
    if (command && summary) {
      const status: Exclude<WorkValidationStatus, 'pending'> = summary.status === 'passed' ? 'passed' : 'failed';
      upsertValidation(state, command, status, summary.summaryText, summary.kind);
      state.validationSeq = seq;
      state.phase = 'validating';
      state.lastProgressAt = now;
      if (status === 'failed') {
        state.blockers = [...new Set([...state.blockers, `Validation failed: ${command}`])];
      }
    }
  }

  state.revision = seq;
  return state;
}

/**
 * Derive the bounded validation outcome for completion evidence.
 * See `ValidationOutcome` for the contract. Honors mutation/validation
 * ordering so a result that predates the latest mutation is `stale`.
 */
export function deriveValidationOutcome(state: WorkState): ValidationOutcome {
  const hasValidation = state.validationSeq > 0;
  if (!hasValidation) {
    return intentExpectsValidation(state.normalizedIntent) ? 'absent' : 'not_applicable';
  }
  // A validation is stale when a mutation happened after it. `mutationSeq === 0`
  // means no mutation occurred (e.g. a pure test/run request), so the latest
  // validation stands on its own.
  const stale = state.mutationSeq > 0 && state.validationSeq < state.mutationSeq;
  if (stale) return 'stale';
  const latest = state.validations.at(-1);
  return latest?.status === 'passed' ? 'passed' : 'failed';
}

export function workStatePrompt(state: WorkState) {
  return `<work_state>\n${JSON.stringify(state)}\n</work_state>`;
}
