import type {RequestIntent} from './goalPolicy.js';
import {isValidationSummary, type ValidationKind, type ValidationSummary} from '../../llm/toolResultTypes.js';
import {toolInputField, toolOutputOk} from './toolResults.js';

export type WorkFileAction = 'read' | 'created' | 'modified';
export type WorkValidationStatus = 'pending' | 'passed' | 'failed';
type WorkStatus = 'active' | 'needs-user' | 'blocked' | 'complete' | 'aborted';
type WorkPhase = 'starting' | 'inspecting' | 'editing' | 'validating' | 'summarizing' | 'done';

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
  /**
   * Current-turn task-list evidence, recorded only from a successful `writeTasks`
   * result. Counts only — never task titles or raw output — so malformed tool
   * output can never fabricate or erase completion evidence. Absent when the
   * turn never declared a task list (a stale workspace tasks.json from an
   * earlier turn must not block completion).
   */
  taskProgress?: WorkTaskProgress;
  /**
   * Validation evidence carried from earlier physical turns of the same
   * logical goal (see the goal supervisor). Used by `deriveValidationOutcome`
   * only while this turn itself has recorded no validation; a fresh
   * validation this turn supersedes it. Bounded to status/kind — never a
   * command or output.
   */
  carriedValidation?: {status: 'passed' | 'failed'; kind?: ValidationKind};
  /** Single source of truth for blockers; the most recent entry is the current one (CR-023). */
  blockers: string[];
  pending: string[];
  nextAction?: string;
  status: WorkStatus;
  phase: WorkPhase;
  lastProgressAt: number;
  revision: number;
}

/** Compact current-turn task-list evidence parsed from a successful `writeTasks` result. */
export interface WorkTaskProgress {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  /** WorkState revision when this snapshot was recorded. */
  revision: number;
}

/** Upper bound for parsed task counts; anything larger is treated as malformed. */
const TASK_COUNT_LIMIT = 10_000;

function boundedTaskCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= TASK_COUNT_LIMIT) return value;
  if (typeof value === 'string' && /^(0|[1-9]\d{0,4})$/.test(value)) return Number(value);
  return undefined;
}

/**
 * Extract bounded task counts from a successful `writeTasks` structured result.
 * Parses only numeric counts (`taskCount`, `counts.pending/in_progress/completed`),
 * never titles or raw output. A non-empty list without a fully valid counts
 * breakdown is ignored (rather than guessed) so partial shapes stay inert.
 */
export function taskProgressFromOutput(output: unknown, revision: number): WorkTaskProgress | undefined {
  if (typeof output !== 'object' || output == null) return undefined;
  const candidate = output as {ok?: unknown; taskCount?: unknown; counts?: unknown};
  if (candidate.ok !== true) return undefined;
  const total = boundedTaskCount(candidate.taskCount);
  if (total === undefined) return undefined;
  if (total === 0) return {total: 0, pending: 0, inProgress: 0, completed: 0, revision};
  if (typeof candidate.counts !== 'object' || candidate.counts === null) return undefined;
  const counts = candidate.counts as Record<string, unknown>;
  const pending = boundedTaskCount(counts.pending);
  const inProgress = boundedTaskCount(counts.in_progress);
  const completed = boundedTaskCount(counts.completed);
  if (pending === undefined || inProgress === undefined || completed === undefined) return undefined;
  return {total, pending, inProgress, completed, revision};
}

/**
 * Seed a fresh per-turn work state with cumulative evidence from earlier
 * physical turns of the same logical goal, so a new turn cannot complete while
 * previously-declared tasks remain or previously-made edits still lack fresh
 * validation. Seq baselines keep `deriveValidationOutcome` truthful across the
 * boundary: a carried `stale`/`absent` outcome keeps demanding validation, a
 * carried `passed`/`failed` outcome stands until this turn mutates or validates.
 */
export function seedCarriedGoalEvidence(state: WorkState, carried: {mutationCount: number; validationOutcome: ValidationOutcome; taskProgress?: WorkTaskProgress}) {
  if (carried.taskProgress && carried.taskProgress.total > 0) {
    state.taskProgress = {...carried.taskProgress, revision: 1};
  }
  if (carried.mutationCount > 0) {
    state.mutationCount = carried.mutationCount;
    state.mutationSeq = 1;
  }
  if (carried.validationOutcome === 'passed' || carried.validationOutcome === 'failed') {
    state.validationSeq = 1;
    state.carriedValidation = carried.validationOutcome === 'passed' ? {status: 'passed'} : {status: 'failed'};
  }
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

  // Only a classifier-confirmed shell command is a validation step. An arbitrary
  // shell call (inspection, mkdir, echo) is process work, not validation; the
  // bash tool embeds a `validationSummary` exactly when the classifier says so.
  if (event.toolName === 'shell') {
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

  // Task-list coordination: a successful writeTasks result records bounded
  // current-turn task counts as completion evidence. It is not a file mutation,
  // and a failed call leaves prior evidence untouched.
  if (ok && event.toolName === 'writeTasks') {
    const progress = taskProgressFromOutput(event.output, seq);
    if (progress) {
      state.taskProgress = progress;
      state.lastProgressAt = now;
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
  // validation stands on its own. With no validation this turn, a carried
  // outcome from an earlier physical turn of the same logical goal stands in.
  const stale = state.mutationSeq > 0 && state.validationSeq < state.mutationSeq;
  if (stale) return 'stale';
  const latest = state.validations.at(-1) ?? state.carriedValidation;
  return latest?.status === 'passed' ? 'passed' : 'failed';
}

export function workStatePrompt(state: WorkState) {
  return `<work_state>\n${JSON.stringify(state)}\n</work_state>`;
}
