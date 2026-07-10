import {classifyRequestIntent, type RequestIntent} from './requestClassifier.js';
import {createWorkState, observeWorkToolEvent, type WorkState, type WorkStatus, type WorkValidationStatus} from '../agent/workState.js';

export type SessionGoalStatus = WorkStatus;
export type ValidationStatus = WorkValidationStatus;
export type SessionGoal = WorkState;
export type GoalToolEvent = Parameters<typeof observeWorkToolEvent>[1];

function shortRequest(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 160) || 'current request';
}

export function createSessionGoal(request: string, now = Date.now(), forceIntent?: RequestIntent): SessionGoal {
  const intent = forceIntent ?? classifyRequestIntent(request);
  const successCriteria = intent === 'plan'
    ? ['Create or update the requested plan artifact/answer', 'Do not implement source changes unless asked']
    : intent === 'test'
      ? ['Run the requested validation or closest relevant check', 'Report pass/fail accurately']
      : intent === 'review'
        ? ['Inspect the relevant current project state', 'Return evidence-based findings with file paths']
        : intent === 'answer'
          ? ['Answer the user using current project context when needed']
          : ['Inspect the relevant files', 'Make the requested change when needed', 'Validate the change when practical', 'Summarize only current-task changes and validation'];
  return createWorkState(request, intent, successCriteria, now);
}

export function observeGoalToolEvent(goal: SessionGoal, event: GoalToolEvent, now = Date.now()) {
  return observeWorkToolEvent(goal, event, now);
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
