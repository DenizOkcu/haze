import crypto from 'node:crypto';
import type {RequestIntent} from './goalPolicy.js';
import {isValidationSummary, type ValidationKind, type ValidationSummary} from '../../llm/toolResultTypes.js';
import {toolInputField, toolOutputOk} from './toolResults.js';
import {workspacePathKey} from '../../utils/path.js';
import {isSingleForegroundCommand} from '../safety/shellClassifier.js';
import {changedPathsFromTool} from './toolCapabilities.js';

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

/**
 * Normalize a validation command into a matching key so a green run can be
 * bound to the red repro it must supersede (P4). Whitespace-insensitive; a
 * leading `time`/`nice` prefix, `env` with or without `VAR=value` assignments,
 * a lone line-continuation backslash, and a trailing `--` separator are noise.
 */
export function validationCommandKey(command: string): string {
  const words = command.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && ['time', 'nice', '\\'].includes(words[0]!)) words.shift();
  // `env` — bare, with flags, or with `VAR=value` assignments — is wrapper
  // noise for pair matching (R2-06): drop it together with any flag tokens
  // and assignments, keeping at least the command word. `env` is handled here
  // only (not in the loop above) so its assignments are stripped too.
  if (words[0] === 'env') {
    let i = 1;
    while (i < words.length && (words[i]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!))) i++;
    if (i < words.length) words.splice(0, i);
  }
  while (words.length > 1 && words.at(-1) === '--') words.pop();
  const normalized = words.join(' ');
  // npm's --prefix form and a simple `cd` wrapper address the same package.
  // Keep this deliberately narrow: parsing arbitrary shell syntax would risk
  // treating unrelated checks as interchangeable.
  const cdNpm = /^cd ([A-Za-z0-9_./-]+) && npm (.+)$/.exec(normalized);
  const prefixNpm = /^npm --prefix ([A-Za-z0-9_./-]+) (.+)$/.exec(normalized);
  const match = cdNpm ?? prefixNpm;
  // `cd` changes the directory for subsequent stages; --prefix does not.
  // Only normalize a single npm invocation, never a compound command.
  return match && isSingleForegroundCommand(match[2]!)
    ? `npm@${workspacePathKey(match[1]!)} ${match[2]}` : normalized;
}

/**
 * Scope identity for failed-check pairing: the check kind plus, for package
 * managers, the package root the check ran against. A failed check stays open
 * until an equivalent check in the same scope passes — the observed failure
 * mode (2026-10-04 goal `on373gg0l1e`) was a red `npm test -- tests/x | tail`
 * and a green bare `npm test` that could never pair because the exact command
 * text differed. Scope deliberately broad: the same suite passed from the same
 * package root is the same check. Arguments are noise a model legitimately
 * varies between runs (`-- tests/foo`, `| tail -25`, `2>&1`).
 */
function failedCheckScope(command: string): string {
  // Run on the normalized key so `cd pkg && npm test` and `npm --prefix pkg test`
  // already agree; only then classify the invocation itself.
  const normalized = validationCommandKey(command);
  const scoped = /^npm@(\S+) /.exec(normalized);
  if (scoped) return `npm@${scoped[1]}`;
  // Chained commands (`&&`, `;`, `||`) are a different check than their stages:
  // a red `npm test && npm run lint` must not be cleared by a green bare
  // `npm test`. The compound gets its own hashed (non-reversible) scope.
  // Pipes/redirects (`| tail`, `2>&1`) are decoration, not chaining — the
  // pipefail-injected pipeline reports the check's own exit status.
  if (/&&|;|\|\|/.test(normalized)) return `compound@${validationCheckId(normalized)}`;
  const manager = /^(?:npm|npx|pnpm|yarn|bun|bunx|deno)\b/.test(normalized) ? 'npm' : 'direct';
  if (manager === 'npm') return `npm@${workspacePathKey('.')}`;
  // Direct commands pair only within the same executable: `cargo test` red
  // pairs with `cargo test` green, never with `pytest`.
  const executable = normalized.split(' ')[0] ?? '';
  return `direct@${workspacePathKey('.')}:${executable}`;
}

/** Stable, non-reversible identity safe to carry in a goal checkpoint. */
export function validationCheckId(command: string): string {
  return crypto.createHash('sha256').update(validationCommandKey(command)).digest('hex').slice(0, 16);
}

/** Encode check identity as `scope:kind:hash`. Self-describing so a pass can pair against carried ids without keeping raw commands. */
function scopedCheckId(command: string, kind: ValidationKind | undefined): string {
  return `${failedCheckScope(command)}:${kind ?? 'generic'}:${validationCheckId(command)}`;
}

/** Scope portion of a check id; unknown/legacy shapes (bare hashes from older checkpoints) map to their own scope so only an exact-text rerun can clear them. */
function scopeOfCheckId(id: string): string {
  const at = id.indexOf(':');
  return at > 0 ? id.slice(0, at) : id;
}

/**
 * Opportunistic red→green state for fix intents: no failing repro is required,
 * but when a pre-mutation validation did fail, that same check must pass after
 * the fix. `missing` therefore means "captured red has no matching green", not
 * "no red was captured".
 */
export function redPairStatus(state: Pick<WorkState, 'normalizedIntent' | 'mutationCount' | 'mutationSeq' | 'redEvidence' | 'validations'>): 'not-required' | 'missing' | 'satisfied' {
  if (state.normalizedIntent !== 'fix' || state.mutationCount === 0) return 'not-required';
  const red = state.redEvidence;
  if (!red) return 'not-required';
  const green = state.validations.some(validation => validation.status === 'passed'
    && validation.revision >= state.mutationSeq
    && validationCommandKey(validation.command) === red.commandKey);
  return green ? 'satisfied' : 'missing';
}

export interface WorkState {
  id: string;
  goal: string;
  originalUserRequest: string;
  intent: RequestIntent;
  normalizedIntent: RequestIntent;
  successCriteria: string[];
  /** Broad requests must declare and finish an outcome list through writeTasks. */
  requiresTaskLedger?: boolean;
  constraints: string[];
  decisions: Array<{decision: string; reason?: string}>;
  files: Array<{path: string; action: WorkFileAction; note?: string}>;
  touchedFiles: string[];
  validations: Array<{command: string; status: Exclude<WorkValidationStatus, 'pending'>; summary: string; revision: number; kind?: ValidationKind}>;
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
   * command or output. `kind` keeps cross-turn parity with the in-turn rule
   * that a generic (self-declared) pass cannot clear a confirmed failure
   * (R2-03).
   */
  carriedValidation?: {status: 'passed' | 'failed'; kind?: ValidationKind};
  /** Failed confirmed checks from earlier physical turns, identified without persisting commands. */
  carriedFailedCheckIds?: string[];
  /** Captured pre-mutation failing repro for fix goals. Optional, but same-check green is required when present. */
  redEvidence?: RedEvidence;
  /** Single source of truth for blockers; the most recent entry is the current one (CR-023). */
  blockers: string[];
  pending: string[];
  nextAction?: string;
  status: WorkStatus;
  phase: WorkPhase;
  lastProgressAt: number;
  revision: number;
}

/** Captured failing repro observed before the first mutation of a fix goal (P4). Safe metadata: command + status, never output bodies. */
export interface RedEvidence {
  command: string;
  commandKey: string;
  summary: string;
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

export function seedCarriedGoalEvidence(state: WorkState, carried: {mutationCount: number; validationOutcome: ValidationOutcome; taskProgress?: WorkTaskProgress; redEvidence?: RedEvidence; validationKind?: ValidationKind; failedCheckIds?: string[]}) {
  if (carried.taskProgress && carried.taskProgress.total > 0) {
    state.taskProgress = {...carried.taskProgress, revision: 1};
  }
  if (carried.mutationCount > 0) {
    state.mutationCount = carried.mutationCount;
    state.mutationSeq = 1;
  }
  if (carried.validationOutcome === 'passed' || carried.validationOutcome === 'failed') {
    state.validationSeq = 1;
    state.carriedValidation = carried.validationOutcome === 'passed'
      ? {status: 'passed', ...(carried.validationKind ? {kind: carried.validationKind} : {})}
      : {status: 'failed', ...(carried.validationKind ? {kind: carried.validationKind} : {})};
  }
  if (carried.failedCheckIds?.length) state.carriedFailedCheckIds = [...carried.failedCheckIds];
  // Red→green evidence is goal-scoped and rides the checkpoint across
  // physical turns so a continuation cannot complete while a carried pair
  // stays unsatisfied.
  if (carried.redEvidence) state.redEvidence = {...carried.redEvidence};
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

/** Kind portion of a check id (`scope:kind:hash`). */
function kindOfCheckId(id: string): string | undefined {
  const parts = id.split(':');
  return parts.length >= 3 ? parts[1] : undefined;
}

/**
 * Equivalence rule for failed-check clearing: same package-manager scope and
 * same confirmed kind. Kind matters — a green `npm run build` (build) cannot
 * clear a red `npm test` (test); they are different checks that happen to share
 * the scope. Legacy ids without a kind component only pair with themselves.
 */
function checkIdEquivalent(passId: string, failedId: string): boolean {
  if (passId === failedId) return true;
  const kind = kindOfCheckId(passId);
  return kind != null && kind !== 'generic' && scopeOfCheckId(passId) === scopeOfCheckId(failedId) && kindOfCheckId(failedId) === kind;
}

function upsertValidation(state: WorkState, command: string, status: Exclude<WorkValidationStatus, 'pending'>, summary: string, kind: ValidationKind | undefined, revision: number) {
  // Keep both evidence and status display in execution order when a check reruns.
  const key = validationCommandKey(command);
  state.validations = state.validations.filter(validation => validationCommandKey(validation.command) !== key);
  // Same-turn failed checks pair across argument variants just like carried ids
  // (R2-07, observed 2026-10-04: a red `npx vitest run tests/x | tail -25` stayed
  // open forever while three green `npm test` runs could never clear it because
  // only the exact command text paired). An authoritative pass clears every
  // equivalent failed entry — same package scope, same confirmed kind.
  if (status === 'passed' && kind && kind !== 'generic') {
    const passId = scopedCheckId(command, kind);
    state.validations = state.validations.filter(validation => !(validation.status === 'failed' && validation.kind != null && validation.kind !== 'generic' && checkIdEquivalent(passId, scopedCheckId(validation.command, validation.kind))));
  }
  state.validations.push({command, status, summary, revision, ...(kind ? {kind} : {})});
  state.validationCommands = state.validationCommands.filter(item => item.command !== command);
  state.validationCommands.push({command, status});
}

const ARTIFACT_LAUNCHERS = new Set(['node', 'python', 'python3', 'ruby', 'php', 'perl', 'sh', 'bash', 'zsh', 'fish', 'csh', 'tcsh', 'tsx', 'ts-node', 'rscript', 'lua']);

function shellWords(command: string) {
  return (command.match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')+/g) ?? [])
    .map(word => ((word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'")) ? word.slice(1, -1) : word));
}

/** Strictly recognize direct execution of one file changed during this goal. */
function executedMutatedArtifact(command: string, state: WorkState): string | undefined {
  // Chaining and pipelines can mask the artifact's exit status, so they are not evidence.
  if (!isSingleForegroundCommand(command)) return undefined;
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

  const changedPaths = changedPathsFromTool(event.toolName, event.input, event.output, event.success);
  for (const changedPath of changedPaths) {
    upsertFile(state, changedPath, event.toolName === 'writeFile' ? 'created' : 'modified');
    state.blockers = state.blockers.filter(blocker => !blocker.includes(changedPath));
  }
  if (changedPaths.length > 0) {
    state.phase = 'editing';
    state.lastProgressAt = now;
    state.mutationCount += changedPaths.length;
    state.mutationSeq = seq;
  }
  if (!ok && path && ['editFile', 'replaceLines', 'writeFile'].includes(event.toolName)) {
    state.blockers = [...new Set([...state.blockers, `Edit failed for ${path}: ${outputSummary(event.output) || 'fresh read required'}`])];
    state.nextAction = `Read ${path}, then retry the edit with current content.`;
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
      upsertValidation(state, command, status, summaryText, summary?.kind ?? 'generic', seq);
      if (status === 'passed' && summary && summary.kind !== 'generic') {
        // Clear the failed-check identities this authoritative pass satisfies,
        // not just the exact same command text: a red `npm test -- tests/x | tail`
        // must be cleared by a green bare `npm test` in the same package scope.
        // Generic custom checks never clear — the self-certification guard holds
        // across turn boundaries too.
        const passId = scopedCheckId(command, summary.kind);
        const remaining = state.carriedFailedCheckIds?.filter(id => !checkIdEquivalent(passId, id)) ?? [];
        state.carriedFailedCheckIds = remaining.length ? remaining : undefined;
      }
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

/** Upper bound for parsed task counts; anything larger is treated as malformed. */
const TASK_COUNT_LIMIT = 10_000;

function boundedTaskCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= TASK_COUNT_LIMIT) return value;
  if (typeof value === 'string' && /^(0|[1-9]\d{0,4})$/.test(value)) return Number(value);
  return undefined;
}

/** Extract bounded task counts from a successful `writeTasks` structured result. */
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
 * Derive the bounded validation outcome for completion evidence.
 * See `ValidationOutcome` for the contract. Honors mutation/validation
 * ordering so a result that predates the latest mutation is `stale`.
 */
export function deriveValidationOutcome(state: WorkState): ValidationOutcome {
  const hasValidation = state.validationSeq > 0;
  if (!hasValidation) {
    return intentExpectsValidation(state.normalizedIntent) || (state.normalizedIntent === 'unknown' && state.mutationCount > 0)
      ? 'absent' : 'not_applicable';
  }
  // A validation is stale when a mutation happened after it. `mutationSeq === 0`
  // means no mutation occurred (e.g. a pure test/run request), so the latest
  // validation stands on its own. With no validation this turn, a carried
  // outcome from an earlier physical turn of the same logical goal stands in.
  const stale = state.mutationSeq > 0 && state.validationSeq < state.mutationSeq;
  if (stale) return 'stale';
  const latest = state.validations.at(-1) ?? state.carriedValidation;
  if (latest?.status !== 'passed') return 'failed';
  if (unresolvedFailedCheckIds(state).length > 0) return 'failed';
  // A self-declared custom check (generic kind, `purpose=validation`) cannot
  // clear a failed classifier-confirmed validation: known test/build commands
  // are the authoritative completion evidence, custom checks supplement them
  // (found by the honest-impossibility eval — a model ran `npm test` red, then
  // passed an unrelated self-written script and claimed completion). A failed
  // validation carried from a goal checkpoint counts as confirmed too.
  const confirmedFailed = state.validations.some(entry => entry.kind !== 'generic' && entry.status === 'failed')
    || (latest.kind === 'generic' && !state.carriedFailedCheckIds && state.carriedValidation?.status === 'failed' && state.carriedValidation.kind !== 'generic');
  if (confirmedFailed) return 'failed';
  return 'passed';
}

export function unresolvedFailedCheckIds(state: WorkState): string[] {
  const local = state.validations.filter(entry => entry.kind !== 'generic' && entry.status === 'failed').map(entry => scopedCheckId(entry.command, entry.kind));
  // Completion evidence must keep every open identity across turn boundaries.
  // Bound only the model-facing preview, not the authoritative check set.
  return [...new Set([...(state.carriedFailedCheckIds ?? []), ...local])];
}

export function workStatePrompt(state: WorkState) {
  // Compaction needs a continuity capsule, not a second copy of every file
  // read and validation ever observed. Keep the exact request and open-check
  // identities; the recent conversation still carries detailed tool results.
  const capsule = {
    request: state.originalUserRequest.slice(0, 1_200),
    intent: state.normalizedIntent,
    successCriteria: state.successCriteria.slice(0, 8).map(item => item.slice(0, 160)),
    requiresTaskLedger: state.requiresTaskLedger,
    constraints: state.constraints.slice(0, 8).map(item => item.slice(0, 160)),
    decisions: state.decisions.slice(-5).map(item => ({decision: item.decision.slice(0, 160), reason: item.reason?.slice(0, 160)})),
    files: state.files.slice(-12).map(file => ({path: file.path.slice(0, 160), action: file.action})),
    mutationCount: state.mutationCount,
    validationOutcome: deriveValidationOutcome(state),
    openCheckIds: unresolvedFailedCheckIds(state).slice(0, 8),
    openCheckCount: unresolvedFailedCheckIds(state).length,
    // The red-check command is safe checkpoint metadata; without it a compacted
    // model cannot know which command must pass to close the red pair.
    ...(state.redEvidence && redPairStatus(state) !== 'satisfied' ? {openRedCheck: state.redEvidence.command.slice(0, 200)} : {}),
    taskProgress: state.taskProgress,
    blockers: state.blockers.slice(-3).map(item => item.slice(0, 160)),
    nextAction: state.nextAction?.slice(0, 200),
  };
  return `<work_state>\n${JSON.stringify(capsule)}\n</work_state>`;
}
