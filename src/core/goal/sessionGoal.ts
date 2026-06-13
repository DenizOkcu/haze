import {classifyRequestIntent, type RequestIntent} from './requestClassifier.js';
import {createWorkState, observeWorkToolEvent, type WorkState} from '../agent/workState.js';

export type SessionGoalStatus = 'active' | 'needs-user' | 'blocked' | 'complete' | 'aborted';
export type ValidationStatus = 'pending' | 'passed' | 'failed';

export interface SessionGoal {
  id: string;
  originalUserRequest: string;
  normalizedIntent: RequestIntent;
  successCriteria: string[];
  constraints: string[];
  touchedFiles: string[];
  validationCommands: Array<{command: string; status: ValidationStatus}>;
  status: SessionGoalStatus;
  phase: 'starting' | 'inspecting' | 'editing' | 'validating' | 'summarizing' | 'done';
  blocker?: string;
  lastProgressAt: number;
  workState: WorkState;
}

export interface GoalToolEvent {
  toolName: string;
  input?: unknown;
  success: boolean;
  output?: unknown;
  error?: unknown;
  duplicateSkipped?: boolean;
}

function shortRequest(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 160) || 'current request';
}

function inputPath(input: unknown) {
  return typeof input === 'object' && input != null && 'path' in input && typeof (input as {path?: unknown}).path === 'string'
    ? (input as {path: string}).path
    : undefined;
}

function bashCommand(input: unknown) {
  return typeof input === 'object' && input != null && 'command' in input && typeof (input as {command?: unknown}).command === 'string'
    ? (input as {command: string}).command
    : undefined;
}

function uniquePush(values: string[], value: string) {
  if (!values.includes(value)) values.push(value);
}

export function createSessionGoal(request: string, now = Date.now()): SessionGoal {
  const intent = classifyRequestIntent(request);
  const criteria = intent === 'plan'
    ? ['Create or update the requested plan artifact/answer', 'Do not implement source changes unless asked']
    : intent === 'test'
      ? ['Run the requested validation or closest relevant check', 'Report pass/fail accurately']
      : intent === 'review'
        ? ['Inspect the relevant current project state', 'Return evidence-based findings with file paths']
        : intent === 'answer'
          ? ['Answer the user using current project context when needed']
          : ['Inspect the relevant files', 'Make the requested change when needed', 'Validate the change when practical', 'Summarize only current-task changes and validation'];

  const successCriteria = criteria;
  return {
    id: `goal-${now}-${Math.random().toString(36).slice(2)}`,
    originalUserRequest: request,
    normalizedIntent: intent,
    successCriteria,
    constraints: [],
    touchedFiles: [],
    validationCommands: [],
    status: 'active',
    phase: 'starting',
    lastProgressAt: now,
    workState: createWorkState(request, intent, successCriteria),
  };
}

export function observeGoalToolEvent(goal: SessionGoal, event: GoalToolEvent, now = Date.now()) {
  if (event.duplicateSkipped) return goal;
  observeWorkToolEvent(goal.workState, event);

  if (event.success && ['listFiles', 'readFile'].includes(event.toolName)) {
    goal.phase = goal.phase === 'editing' || goal.phase === 'validating' ? goal.phase : 'inspecting';
    goal.lastProgressAt = now;
  }

  goal.workState.phase = goal.phase;

  if (['editFile', 'replaceLines', 'writeFile'].includes(event.toolName)) {
    const path = inputPath(event.input);
    if (path) uniquePush(goal.touchedFiles, path);
    if (event.success) {
      goal.phase = 'editing';
      goal.lastProgressAt = now;
    } else {
      goal.blocker = `File edit failed${path ? ` for ${path}` : ''}; recovery read is required before retry.`;
    }
  }

  goal.workState.phase = goal.phase;

  if (event.toolName === 'bash') {
    const command = bashCommand(event.input);
    if (command) {
      const ok = typeof event.output === 'object' && event.output != null && 'ok' in event.output ? Boolean((event.output as {ok?: unknown}).ok) : event.success;
      const existing = goal.validationCommands.find(item => item.command === command);
      const status: ValidationStatus = ok ? 'passed' : 'failed';
      if (existing) existing.status = status;
      else goal.validationCommands.push({command, status});
      goal.phase = 'validating';
      goal.lastProgressAt = now;
      if (!ok) goal.blocker = `Validation command failed: ${command}`;
    }
  }

  goal.workState.phase = goal.phase;

  return goal;
}

export function formatGoalStatus(goal: SessionGoal) {
  const action = goal.phase === 'starting' ? 'starting'
    : goal.phase === 'inspecting' ? 'inspecting'
      : goal.phase === 'editing' ? `${goal.touchedFiles.length} file${goal.touchedFiles.length === 1 ? '' : 's'} changed`
        : goal.phase === 'validating' ? `validation ${goal.validationCommands.at(-1)?.status ?? 'running'}`
          : goal.phase === 'summarizing' ? 'summarizing'
            : 'done';
  return `Goal: ${shortRequest(goal.originalUserRequest)} · ${action}`;
}
