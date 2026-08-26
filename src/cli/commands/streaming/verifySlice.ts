import type {ContextFile} from '../../../config/contextFiles.js';
import {providerRequestSettings, type ModelRuntimeSelection} from '../../../llm/client.js';
import type {PromptSession} from '../../../llm/systemPrompt.js';
import {type SessionGoal} from '../../../core/agent/goalPolicy.js';
import {applyVerifierVerdict, intentExpectsValidation, openAsksOf} from '../../../core/agent/workState.js';
import {runVerifier} from '../../../core/subagent/subagentRunner.js';
import type {TurnExecutionScope} from '../../../llm/requestContext.js';
import type {StreamCallbacks} from '../streaming.js';

/** Floor on remaining turn time before dispatching a verification slice. */
export const VERIFY_SLICE_MIN_REMAINING_MS = 60_000;

/**
 * Proportionality + trigger (P3/P5): one independent verification slice runs
 * before the first accepted voluntary final of an implement/fix/test goal with
 * at least one mutation — unless the goal is `trivial` (ceremony stays
 * proportional) or verification already passed for this logical goal. The
 * universal floor (post-mutation validation, zero pending tasks/asks) is
 * checked by completion readiness before the slice is ever admitted.
 */
export function verificationRequired(goal: SessionGoal): boolean {
  return !goal.verified
    && goal.mutationCount > 0
    && intentExpectsValidation(goal.intent)
    && goal.shape !== 'trivial';
}

/**
 * Dispatch the blind verifier and record its structured verdict on the goal.
 * One slice per physical turn (the caller's `verifySliceUsed` flag); the slice
 * never re-arms budgets and counts as completion evidence only — a
 * `not-verified` verdict rejects the voluntary final and flows into the
 * existing goal-continuation recovery with the verifier's named gaps.
 */
export async function runVerificationSlice(deps: {
  goal: SessionGoal;
  runtime: ModelRuntimeSelection;
  contextFiles: ContextFile[];
  session: PromptSession | undefined;
  abortSignal: AbortSignal;
  turnScope: {executionScope?: TurnExecutionScope};
  callbacks: StreamCallbacks;
}): Promise<void> {
  const {goal, runtime, contextFiles, session, abortSignal, turnScope, callbacks} = deps;
  const asks = goal.asks?.map(ask => ask.text) ?? [];
  callbacks.setBusyLabel?.('independent verification');
  callbacks.debugLog('verify slice: dispatching blind verifier');
  try {
    const {verdict, capsule, termination} = await runVerifier({
      request: goal.originalUserRequest,
      asks,
      changedFiles: goal.touchedFiles,
      claimedValidations: goal.validationCommands.map(item => item.command),
      runtime: {
        model: runtime.model,
        selector: runtime.selector,
        providerName: runtime.config.providerName,
        capabilities: runtime.config.capabilities,
        requestOptions: providerRequestSettings(runtime.config),
      },
      contextFiles,
      session,
      abortSignal,
      mutationPolicy: turnScope.executionScope?.mutationPolicy,
    });
    applyVerifierVerdict(goal, verdict);
    if (verdict.verdict === 'verified') {
      callbacks.addMessage({role: 'system', text: `Independent verification passed: a fresh context re-derived the request against the repository and confirmed it is met.${verdict.regressions.length > 0 ? ` Observed regressions to review: ${verdict.regressions.join('; ')}` : ''}`});
    } else {
      callbacks.addMessage({role: 'system', text: `Independent verification rejected completion. A fresh context re-derived the request against the repository and found: ${verdict.gaps.join(' ')}`});
      callbacks.debugLog(`verify slice rejected (${termination}): ${capsule.deliverable.slice(0, 300)}`);
    }
  } catch (error) {
    // Default-FAIL (autoprompt G6): a verifier that errors entirely still
    // blocks the final — with the failure named, never a silent pass.
    const message = error instanceof Error ? error.message : String(error);
    applyVerifierVerdict(goal, {verdict: 'not-verified', gaps: [`verification slice failed to run: ${message.slice(0, 160)}`]});
    callbacks.addMessage({role: 'system', text: 'Independent verification could not run; completion stays blocked until it passes. Retry will happen on the next completion attempt.'});
    callbacks.debugLog(`verify slice error: ${message}`);
  }
}

/** Open ask texts for prompts and evidence (bounded, top 3 by policy in the prompt). */
export function openAskTexts(goal: SessionGoal): string[] {
  return openAsksOf(goal).map(ask => ask.text);
}
