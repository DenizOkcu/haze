import {isActionRequest, isPlanOnlyRequest, isValidationRequest} from './requestClassifier.js';
import type {SessionGoal} from './sessionGoal.js';

export function looksIncomplete(text: string) {
  return /\b(incomplete|what remains|remains:|remaining:|next:|unfinished|not implemented|not created|no tests exist|created no docs|has not been|have not been|not yet|never executed|not executed|not run|cannot retry|cannot write|cannot validate|tool budget reached|tool slice reached)/i.test(text);
}

export function looksTruncated(text: string) {
  const trimmed = text.trimEnd();
  if (!trimmed) return false;
  const lines = trimmed.split('\n');
  const lastLine = lines[lines.length - 1].trim();
  if (/^#{1,6}\s+\S/.test(lastLine)) return true;
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(lastLine)) return true;
  if (trimmed.endsWith(':')) return true;
  const fences = (trimmed.match(/```/g) ?? []).length;
  if (fences % 2 !== 0) return true;
  return false;
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
  editRecoveryReasonCode?: string;
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
  const assistantAdmitsIncomplete = looksIncomplete(input.assistantText) || looksTruncated(input.assistantText);
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

  const stateLines = [
    `User goal: ${input.request}`,
    input.editRecoveryPath ? `Edit recovery path: ${input.editRecoveryPath}` : undefined,
    input.editRecoveryReasonCode ? `Edit failure reason: ${input.editRecoveryReasonCode}` : undefined,
    input.mutatingToolSucceeded ? 'Files changed in this turn: yes' : 'Files changed in this turn: no',
    input.validationToolSucceeded ? 'Validation status: passed' : input.validationToolFailed ? 'Validation status: failed' : 'Validation status: not run',
  ].filter((line): line is string => line !== undefined).join('\n');

  let continuationPrompt: string | undefined;
  if (input.editFileFailed) {
    continuationPrompt = `State:\n${stateLines}\n\nRequired next action: call readFile on the exact edit recovery path first. Then use the latest line-numbered output with replaceLines, or a corrected editFile call, to complete the requested change. Continue with relevant validation if practical. Do not stop with a summary while tools are available.`;
  } else if (input.validationToolFailed && input.mutatingToolSucceeded) {
    continuationPrompt = `State:\n${stateLines}\n\nRequired next action: Validation failed after files changed in this task. Use the validation summary/output to inspect the first relevant failure, make one focused fix if it is plausibly caused by this change, then rerun the same relevant validation once. If it is an environment/dependency/unrelated failure, finish with Status: blocked or Status: partial and concrete evidence.`;
  } else if (needsValidationContinuation) {
    continuationPrompt = changedActionNeedsValidation
      ? `State:\n${stateLines}\n\nRequired next action: files changed for this request, but no validation has run. Run the smallest relevant test/typecheck/build command you can identify. If no practical validation exists, finish with the final status template and say why validation was not run.`
      : `State:\n${stateLines}\n\nRequired next action: run the requested validation now. Summarize only after the command finishes.`;
  } else if (input.mutatingToolSucceeded && assistantAdmitsIncomplete) {
    continuationPrompt = `State:\n${stateLines}\n\nRequired next action: your previous response described unfinished work. Continue with the remaining in-scope edits and validation for this same request. Do not summarize a plan unless concretely blocked.`;
  } else if (needsActionContinuation) {
    continuationPrompt = `State:\n${stateLines}\n\nRequired next action: you inspected files but have not made the requested change yet. Edit or write the necessary files now. Do not summarize a plan unless concretely blocked.`;
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
  return 'Tool slice reached for this model step — tools are no longer callable in this turn. Stop attempting to describe or announce tool calls (e.g. "Let me install", "Now I\'ll run", "Let me X"); those phrases imply tool use you cannot perform. Answer once: either the final status template (current-turn changes + validation evidence) or, if incomplete, a single short line stating the next concrete unfinished action so Haze can continue in a fresh tool slice. Do not repeat yourself, do not loop, do not emit XML/JSON tool-call syntax.';
}

export function repeatedToolCallPrompt(toolNames: string[]) {
  const names = [...new Set(toolNames)].join(', ');
  return `You already called ${names || 'a tool'} with identical input in this turn. Do not call the same tool again with the same arguments. Use the existing tool result already in the conversation, choose a different concrete tool/input if genuinely needed, or give the final/blocked status now.`;
}

export function postContinuationPrompt() {
  return 'Your previous response still described unfinished work, missing validation, or a tool-budget issue. If tools are available, complete the remaining edit or run the final validation now. Only call something blocked for a concrete tool failure, missing dependency/permission, or unavoidable ambiguity.';
}

export function noTextAfterToolPrompt(allowTools: boolean) {
  return allowTools
    ? 'Continue the original request now. If it asks for a change, edit or write the necessary files. If it asks to run or verify tests, run the command. Do not provide only a retrospective summary unless blocked or needing a user decision.'
    : 'Continue from the tool result and answer my original request. Do not call tools. Use the final status template for implementation-like requests; summarize only current-turn changes and validation; do not recap unrelated earlier tasks.';
}
