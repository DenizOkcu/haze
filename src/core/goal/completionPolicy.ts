import {isActionRequest, isPlanOnlyRequest, isValidationRequest} from './requestClassifier.js';
import type {SessionGoal} from './sessionGoal.js';

export function looksIncomplete(text: string) {
  return /\b(incomplete|what remains|remains:|remaining:|next:|not implemented|not created|no tests exist|created no docs|has not been|have not been|not yet|never executed|not executed|not run|cannot retry|cannot write|cannot validate|tool budget reached)/i.test(text);
}

export function looksBlocked(text: string) {
  return /\b(blocked|blocker|needs user|need user|missing permission|permission denied|missing dependency|no practical validation|unable to validate|can't validate|cannot validate)\b/i.test(text);
}

export interface CompletionPolicyInput {
  request: string;
  goal: SessionGoal;
  assistantText: string;
  sawReadOnlyTool: boolean;
  sawToolCall: boolean;
  mutatingToolSucceeded: boolean;
  validationToolSucceeded: boolean;
  validationToolFailed: boolean;
  editFileFailed: boolean;
  editRecoveryPath?: string;
}

export interface CompletionDecision {
  needsActionContinuation: boolean;
  needsValidationContinuation: boolean;
  requestCompletedByTools: boolean;
  assistantAdmitsIncomplete: boolean;
  assistantReportsBlocker: boolean;
  continuationPrompt?: string;
}

export function completionDecision(input: CompletionPolicyInput): CompletionDecision {
  const likelyPlanOnlyRequest = isPlanOnlyRequest(input.request);
  const likelyActionRequest = isActionRequest(input.request);
  const likelyValidationRequest = isValidationRequest(input.request);
  const assistantAdmitsIncomplete = looksIncomplete(input.assistantText);
  const assistantReportsBlocker = looksBlocked(input.assistantText);
  const requestCompletedByTools = input.mutatingToolSucceeded && input.validationToolSucceeded && !input.editRecoveryPath;
  const changedActionNeedsValidation = likelyActionRequest
    && !likelyPlanOnlyRequest
    && input.mutatingToolSucceeded
    && !input.validationToolSucceeded
    && !input.validationToolFailed
    && !input.editRecoveryPath
    && !assistantReportsBlocker;
  const needsActionContinuation = likelyActionRequest
    && !likelyPlanOnlyRequest
    && !requestCompletedByTools
    && ((input.sawReadOnlyTool && !input.mutatingToolSucceeded) || input.validationToolFailed || input.editFileFailed || assistantAdmitsIncomplete);
  const needsValidationContinuation = (likelyValidationRequest || changedActionNeedsValidation)
    && !requestCompletedByTools
    && !input.validationToolSucceeded
    && !assistantReportsBlocker;

  let continuationPrompt: string | undefined;
  if (input.editFileFailed) {
    continuationPrompt = 'Your editFile attempt failed. Use the latest readFile line-numbered output and replaceLines to complete the requested change. Continue with any remaining tests or validation if relevant. Do not stop with a summary.';
  } else if (input.validationToolFailed && input.mutatingToolSucceeded) {
    continuationPrompt = 'Validation failed after files changed in this task. Inspect the failure output, fix failures that are plausibly caused by the current change, then rerun the relevant validation once. If the failure is clearly unrelated or environment-specific, summarize the blocker instead of expanding scope.';
  } else if (needsValidationContinuation) {
    continuationPrompt = changedActionNeedsValidation
      ? 'Files changed for this request, but no validation has run yet. Continue by running the smallest relevant test/check command you can identify from the project. If no practical validation exists, state that concrete blocker briefly instead of claiming the goal is complete.'
      : 'You have not run the requested validation yet. Continue now by running the appropriate test/check command. Summarize only after the command finishes.';
  } else if (input.mutatingToolSucceeded && assistantAdmitsIncomplete) {
    continuationPrompt = 'Your previous response says the current request is incomplete. Continue now with the remaining edits and validation for this same request. Do not summarize a plan unless blocked.';
  } else if (needsActionContinuation) {
    continuationPrompt = 'You inspected files but have not made the requested change yet. Continue now by editing or writing the necessary files. Do not summarize a plan unless blocked.';
  }

  return {
    needsActionContinuation,
    needsValidationContinuation,
    requestCompletedByTools,
    assistantAdmitsIncomplete,
    assistantReportsBlocker,
    continuationPrompt,
  };
}

export function toolLoopBudgetPrompt() {
  return 'Tool budget reached. You cannot call tools now, and you must not output XML, JSON tool-call syntax, <tool_call> blocks, or function-call markup. If the current request is complete, summarize only current-turn changes and validation. If the requested change is incomplete, state the concrete blocker briefly. Do not claim tools are unavailable, recap unrelated earlier tasks, or provide a generic remains list.';
}

export function postContinuationPrompt() {
  return 'Your previous response still described unfinished work, missing validation, or a tool-budget issue. If any tools are still available, complete the remaining edit or run the final validation now. Only call something a blocker if a concrete tool failure prevents progress.';
}

export function noTextAfterToolPrompt(allowTools: boolean) {
  return allowTools
    ? 'Continue the original request now. If it asks for a change, edit or write the necessary files. If it asks to run or verify tests, run the command. Do not provide only a retrospective summary unless blocked.'
    : 'Continue from the tool result and answer my original request. Do not call tools. Summarize only current-turn changes and validation; do not recap unrelated earlier tasks.';
}
