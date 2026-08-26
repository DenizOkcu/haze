import type {GoalShape, RequestIntent} from './goalPolicy.js';
import {isValidationSummary, type ValidationKind, type ValidationSummary} from '../../llm/toolResultTypes.js';
import {toolInputField, toolOutputOk} from './toolResults.js';
import {workspacePathKey} from '../../utils/path.js';

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

export type AskStatus = 'open' | 'met' | 'waived';

/** One concrete, checkable ask re-derived from the exact user request (P2). */
export interface WorkAsk {
  id: string;
  text: string;
  status: AskStatus;
  /** Bounded reference to the validating event that closed the ask. */
  evidence?: string;
  /** Required when the ask is waived (assumed out of scope, with reason). */
  waiverReason?: string;
}

/** Captured failing repro observed before the first mutation of a fix goal (P4). Safe metadata: command + status, never output bodies. */
export interface RedEvidence {
  command: string;
  commandKey: string;
  summary: string;
}

/** Structured ask-update request echoed by a successful writeTasks result. */
export interface AskUpdateRequest {
  id: string;
  status: 'met' | 'waived';
  evidence?: string;
  waiverReason?: string;
}

/** Outcome of applying one structured ask update. */
export interface AskUpdateOutcome {
  id: string;
  applied: boolean;
  reason?: string;
}

/** Independent verifier verdict recorded as completion evidence (P3). */
export interface VerifyVerdictState {
  verdict: 'verified' | 'not-verified';
  gaps: string[];
}

/** Upper bound for ask text; extraction never emits longer asks. */
export const ASK_TEXT_CHARS = 160;

/** Open (unmet, unwaived) asks of a goal state. */
export function openAsksOf(state: Pick<WorkState, 'asks'>): WorkAsk[] {
  return (state.asks ?? []).filter(ask => ask.status === 'open');
}

/** Waived asks with their recorded reasons (surfaced in the final synthesis). */
export function waivedAsksOf(state: Pick<WorkState, 'asks'>): WorkAsk[] {
  return (state.asks ?? []).filter(ask => ask.status === 'waived');
}

function normalizeEvidenceText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Structural validation for closing an ask (P2: no prose-override channel).
 * `met` requires an evidence reference that matches a *passing* validation
 * command or a file actually changed during this goal; `waived` requires a
 * reason. Anything else is rejected and the ask stays open.
 */
export function applyAskUpdate(state: WorkState, update: AskUpdateRequest): AskUpdateOutcome {
  const ask = (state.asks ?? []).find(item => item.id === update.id || item.text === update.id);
  if (!ask) return {id: update.id, applied: false, reason: 'unknown ask id'};
  if (update.status === 'waived') {
    const reason = update.waiverReason?.trim();
    if (!reason) return {id: update.id, applied: false, reason: 'waiving an ask requires a waiverReason'};
    ask.status = 'waived';
    ask.waiverReason = reason;
    delete ask.evidence;
    return {id: update.id, applied: true};
  }
  const evidence = update.evidence?.trim();
  if (!evidence) return {id: update.id, applied: false, reason: 'marking an ask met requires evidence referencing a passing validation or a changed file'};
  const needle = normalizeEvidenceText(evidence);
  const matchesValidation = state.validations.some(validation => validation.status === 'passed'
    && (normalizeEvidenceText(validation.command).includes(needle) || needle.includes(normalizeEvidenceText(validation.command))));
  const matchesTouchedFile = state.touchedFiles.some(file => {
    const fileKey = normalizeEvidenceText(file);
    return needle.includes(fileKey) || fileKey.includes(needle);
  });
  if (!matchesValidation && !matchesTouchedFile) {
    return {id: update.id, applied: false, reason: 'evidence does not match any passing validation command or changed file'};
  }
  ask.status = 'met';
  ask.evidence = evidence;
  delete ask.waiverReason;
  return {id: update.id, applied: true};
}

/** Apply a bounded batch of echoed ask updates; returns per-update outcomes. */
export function applyAskUpdates(state: WorkState, updates: readonly AskUpdateRequest[]): AskUpdateOutcome[] {
  return updates.slice(0, 10).map(update => applyAskUpdate(state, update));
}

/**
 * Normalize a validation command into a matching key so a green run can be
 * bound to the red repro it must supersede (P4). Whitespace-insensitive; a
 * leading `time`/`env`/`nice` prefix and a trailing `--` separator are noise.
 */
export function validationCommandKey(command: string): string {
  const words = command.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && ['time', 'env', 'nice', '\\'].includes(words[0]!)) words.shift();
  while (words.length > 1 && words.at(-1) === '--') words.pop();
  return words.join(' ');
}

/**
 * Red→green pair state for fix intents (P4): a fix goal with mutations must
 * carry a pre-mutation failing repro (or a structured waiver), and a passing
 * validation of that same command (or an explicitly recorded successor).
 */
export function redPairStatus(state: Pick<WorkState, 'normalizedIntent' | 'shape' | 'mutationCount' | 'redEvidence' | 'redWaiver' | 'greenSuccessor' | 'validations'>): 'not-required' | 'missing' | 'satisfied' | 'waived' {
  if (state.normalizedIntent !== 'fix' || state.shape === 'trivial' || state.mutationCount === 0) return 'not-required';
  if (state.redWaiver) return 'waived';
  const red = state.redEvidence;
  if (!red) return 'missing';
  const successorKey = state.greenSuccessor ? validationCommandKey(state.greenSuccessor) : undefined;
  const green = state.validations.some(validation => validation.status === 'passed'
    && (validationCommandKey(validation.command) === red.commandKey || (successorKey !== undefined && validationCommandKey(validation.command) === successorKey)));
  return green ? 'satisfied' : 'missing';
}

/** Record an independent verifier verdict as goal evidence (P3). */
export function applyVerifierVerdict(state: WorkState, verdict: {verdict: 'verified' | 'not-verified'; asksMet?: boolean[]; gaps?: string[]}) {
  const gaps = (verdict.gaps ?? []).filter(gap => typeof gap === 'string' && gap.trim().length > 0).slice(0, 5).map(gap => gap.trim().slice(0, 200));
  if (verdict.verdict === 'verified') {
    state.verified = true;
    state.verifyVerdict = undefined;
    // Corroborate asks the blind verifier explicitly confirmed.
    (verdict.asksMet ?? []).forEach((met, index) => {
      const ask = state.asks?.[index];
      if (met === true && ask && ask.status === 'open') {
        ask.status = 'met';
        ask.evidence = 'independent verification';
      }
    });
    return;
  }
  state.verifyVerdict = {verdict: 'not-verified', gaps};
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
  /** Asks re-derived from the exact request (P2); gate applies to mutating intents. */
  asks?: WorkAsk[];
  /** Proportional goal shape (P5); escalation up only, never down. */
  shape?: GoalShape;
  /** Captured pre-mutation failing repro for fix goals (P4). */
  redEvidence?: RedEvidence;
  /** Structured waiver when the failing repro is genuinely unobservable here (P4). */
  redWaiver?: {reason: string};
  /** Explicitly recorded successor command binding green to red (P4). */
  greenSuccessor?: string;
  /** Independent verification passed for this logical goal (P3). */
  verified?: boolean;
  /** Latest independent verifier rejection (P3); cleared on continuation. */
  verifyVerdict?: VerifyVerdictState;
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
export function seedCarriedGoalEvidence(state: WorkState, carried: {mutationCount: number; validationOutcome: ValidationOutcome; taskProgress?: WorkTaskProgress; asks?: WorkAsk[]; shape?: GoalShape; redEvidence?: RedEvidence; redWaiver?: {reason: string}; greenSuccessor?: string; verified?: boolean}) {
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
  // Ask/red/shape/verification state is goal-scoped and rides the checkpoint
  // across physical turns so a continuation cannot complete while carried
  // asks stay open or a carried red→green pair stays unsatisfied.
  if (carried.asks?.length) state.asks = carried.asks.map(ask => ({...ask}));
  if (carried.shape) state.shape = carried.shape;
  if (carried.redEvidence) state.redEvidence = {...carried.redEvidence};
  if (carried.redWaiver) state.redWaiver = {...carried.redWaiver};
  if (carried.greenSuccessor) state.greenSuccessor = carried.greenSuccessor;
  if (carried.verified) state.verified = true;
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

const ARTIFACT_LAUNCHERS = new Set(['node', 'python', 'python3', 'ruby', 'php', 'perl', 'sh', 'bash', 'zsh', 'fish', 'csh', 'tcsh', 'tsx', 'ts-node', 'rscript', 'lua']);

function shellWords(command: string) {
  return (command.match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')+/g) ?? [])
    .map(word => ((word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'")) ? word.slice(1, -1) : word));
}

/** Strictly recognize direct execution of one file changed during this goal. */
export function executedMutatedArtifact(command: string, state: WorkState): string | undefined {
  // Chaining and pipelines can mask the artifact's exit status, so they are not evidence.
  if (/&&|\|\||[;|]/.test(command)) return undefined;
  const words = shellWords(command.trim());
  if (words.length === 0) return undefined;
  const executable = words[0]!.replace(/^.*[\\/]/, '').toLowerCase();
  let candidate: string | undefined;
  if (ARTIFACT_LAUNCHERS.has(executable)) {
    const args = words.slice(1);
    if (args.some(word => ['-e', '--eval', '-c', '-m'].includes(word))) return undefined;
    candidate = args.find(word => !word.startsWith('-'));
  } else if (executable === 'go' && words[1] === 'run') {
    candidate = words.slice(2).find(word => !word.startsWith('-'));
  } else if (executable === 'pwsh' || executable === 'powershell') {
    const fileIndex = words.findIndex(word => word.toLowerCase() === '-file');
    candidate = fileIndex >= 0 ? words[fileIndex + 1] : undefined;
  } else if (executable === 'deno' || executable === 'bun') {
    const args = words[1] === 'run' ? words.slice(2) : words.slice(1);
    candidate = args.find(word => !word.startsWith('-'));
  } else if (executable === 'java') {
    const jarIndex = words.indexOf('-jar');
    candidate = jarIndex >= 0 ? words[jarIndex + 1] : undefined;
  } else if (words[0]!.startsWith('./') || words[0]!.startsWith('../')) {
    candidate = words[0];
  }
  if (!candidate) return undefined;
  const candidateKey = workspacePathKey(candidate);
  return state.files.find(file => file.action !== 'read' && workspacePathKey(file.path) === candidateKey)?.path;
}

function shellExitCode(output: unknown) {
  if (typeof output !== 'object' || output == null) return undefined;
  const code = (output as {code?: unknown}).code;
  return typeof code === 'number' || code === null ? code : undefined;
}

/** Extract a classifier-confirmed validation summary from a tool output, if any. */
export function validationSummaryFromOutput(output: unknown): ValidationSummary | undefined {
  if (typeof output !== 'object' || output == null) return undefined;
  const candidate = (output as {validationSummary?: unknown}).validationSummary;
  return isValidationSummary(candidate) ? candidate : undefined;
}

export function createWorkState(goal: string, intent: RequestIntent, successCriteria: string[], now = Date.now(), options: {asks?: WorkAsk[]; shape?: GoalShape} = {}): WorkState {
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
    ...(options.asks?.length ? {asks: options.asks.map(ask => ({...ask}))} : {}),
    ...(options.shape ? {shape: options.shape} : {}),
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

  // Classifier-confirmed test/build commands are validation. A direct execution
  // of a file changed during this goal is also bounded runtime evidence, provided
  // the command is not chained or piped (which could mask its exit status).
  if (event.toolName === 'shell') {
    const command = toolInputField(event.input, 'command');
    const summary = validationSummaryFromOutput(event.output);
    const artifact = command && !summary ? executedMutatedArtifact(command, state) : undefined;
    if (command && (summary || artifact)) {
      const exitCode = shellExitCode(event.output);
      const passed = summary ? summary.status === 'passed' : ok && exitCode === 0;
      const status: Exclude<WorkValidationStatus, 'pending'> = passed ? 'passed' : 'failed';
      const summaryText = summary?.summaryText ?? (passed ? `Executed changed artifact ${artifact} successfully.` : `Changed artifact ${artifact} exited unsuccessfully.`);
      upsertValidation(state, command, status, summaryText, summary?.kind ?? 'generic');
      state.validationSeq = seq;
      state.phase = 'validating';
      state.lastProgressAt = now;
      if (status === 'failed') {
        state.blockers = [...new Set([...state.blockers, `Validation failed: ${command}`])];
        // Red evidence (P4): the first failing repro observed before any
        // mutation of a fix-intent goal is the red half of the red→green pair.
        // Only consumed as a completion requirement — never a mutation blocker.
        if (state.normalizedIntent === 'fix' && state.mutationSeq === 0 && !state.redEvidence) {
          state.redEvidence = {command, commandKey: validationCommandKey(command), summary: summaryText.slice(0, 200)};
        }
      }
    }
  }

  // Task-list coordination: a successful writeTasks result records bounded
  // current-turn task counts as completion evidence, plus any structured ask
  // updates / red waivers the model declared (validated against real events —
  // prose alone can never close an ask or waive the red→green pair). It is not
  // a file mutation, and a failed call leaves prior evidence untouched.
  if (ok && event.toolName === 'writeTasks') {
    const progress = taskProgressFromOutput(event.output, seq);
    if (progress) {
      state.taskProgress = progress;
      state.lastProgressAt = now;
    }
    for (const update of askUpdatesFromOutput(event.output)) {
      applyAskUpdate(state, update);
    }
    const redWaiver = redWaiverFromOutput(event.output);
    if (redWaiver && !state.redWaiver) state.redWaiver = {reason: redWaiver};
    const greenSuccessor = greenSuccessorFromOutput(event.output);
    if (greenSuccessor && !state.greenSuccessor) state.greenSuccessor = greenSuccessor;
  }

  state.revision = seq;
  return state;
}

/**
 * Extract bounded structured ask updates echoed by a successful writeTasks
 * result. Parses only validated shapes (`id`/`status`/optional bounded
 * strings) so malformed tool output can never fabricate ask evidence.
 */
export function askUpdatesFromOutput(output: unknown): AskUpdateRequest[] {
  if (typeof output !== 'object' || output == null) return [];
  const record = output as {ok?: unknown; askUpdates?: unknown};
  if (record.ok !== true) return [];
  const candidate = record.askUpdates;
  if (!Array.isArray(candidate)) return [];
  const updates: AskUpdateRequest[] = [];
  for (const item of candidate.slice(0, 10)) {
    if (typeof item !== 'object' || item == null) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim().slice(0, 64) : '';
    const status = record.status === 'met' || record.status === 'waived' ? record.status : undefined;
    if (!id || !status) continue;
    const evidence = typeof record.evidence === 'string' && record.evidence.trim() ? record.evidence.trim().slice(0, 300) : undefined;
    const waiverReason = typeof record.waiverReason === 'string' && record.waiverReason.trim() ? record.waiverReason.trim().slice(0, 300) : undefined;
    updates.push({id, status, ...(evidence ? {evidence} : {}), ...(waiverReason ? {waiverReason} : {})});
  }
  return updates;
}

function boundedEchoString(output: unknown, field: 'redWaiver' | 'greenSuccessor'): string | undefined {
  if (typeof output !== 'object' || output == null) return undefined;
  const record = output as Record<string, unknown>;
  if (record.ok !== true) return undefined;
  const value = record[field];
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : undefined;
}

/** Structured red-evidence waiver echoed by a successful writeTasks result (P4). */
export function redWaiverFromOutput(output: unknown): string | undefined {
  return boundedEchoString(output, 'redWaiver');
}

/** Explicit green-successor command echoed by a successful writeTasks result (P4). */
export function greenSuccessorFromOutput(output: unknown): string | undefined {
  return boundedEchoString(output, 'greenSuccessor');
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
