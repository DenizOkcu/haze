import {runAgentGoal} from '../commands/streaming/goalSupervisor.js';
import {createQuarantinableCallbacks} from '../commands/streaming/attemptLifecycle.js';
import {resolveModelSelector} from '../../config/providers.js';
import {providerEndpointFingerprint} from '../../config/providers.js';
import {loadTasks as loadTasksFromStore} from '../../core/tasks/taskStorage.js';
import {accumulateTokenUsage} from './turnState.js';
import {nextFleetStatus} from './chatMetrics.js';
import type {TurnExecutionOptions} from '../commands/streaming.js';
import type {ChatScreenDeps, ResumeExisting} from './screenDeps.js';
import {clearTasks as clearTasksFromStore} from '../../core/tasks/taskStorage.js';
import {shouldClearCompletedTasks} from './turnState.js';
import {resumeKindFor} from './userInput.js';
import {routeQueuedLine} from './userCommandFlow.js';

/** A user submission: one turn, then every follow-up queued while it ran (ARCH-05). */
export async function runAgentTurnWithFollowUps(deps: ChatScreenDeps, value: string, displayValue?: string, turnOptions: TurnExecutionOptions = {}) {
  if (deps.stoppingRef.current) return;
  deps.setDebugLogs([]);
  // When every task is already completed, start the new turn with a clean
  // slate: the task bar clears (nothing shown for simple questions) and the
  // model may create fresh todos via writeTasks if the new question warrants.
  if (shouldClearCompletedTasks(deps.visibleTasks)) {
    deps.setVisibleTasks([]);
    deps.setTasksExpanded(false);
    deps.setTaskBarPadding(0);
    await clearTasksFromStore().catch(() => undefined);
  }
  await runSingleAgentTurn(deps, value, displayValue, turnOptions);
  for (let next = deps.followUps.takeNext(); !deps.stoppingRef.current && next !== undefined; next = deps.followUps.takeNext()) {
    // A queued `!` line is a user command, not a prompt.
    const routed = await routeQueuedLine(deps, next);
    if (routed.handled) continue;
    const preparedFollowUp = await deps.prepareUserInput(routed.value);
    if (!preparedFollowUp) continue;
    await runSingleAgentTurn(deps, preparedFollowUp.value, preparedFollowUp.displayValue, preparedFollowUp.options);
  }
}


/**
 * Explicitly resume a genuinely paused goal (automatic continuation already
 * ran): an idle-stall resume continues the bounded retry pool; an
 * incomplete-goal resume restarts the supervisor from the stored checkpoint
 * (kind selection in chat/userInput.ts). Both ride the preserved
 * conversation — no completed mutations are replayed.
 */
export async function resumePausedGoal(deps: ChatScreenDeps) {
  const resume = deps.pausedResume;
  if (!resume || deps.busy) return;
  deps.setPausedResume(undefined);
  deps.setMessages(m => [...m, {role: 'system', text: 'Resuming the unfinished goal; completed work is preserved in the conversation.'}]);
  await runSingleAgentTurn(deps, resume.request, undefined, {}, resumeKindFor(resume) as ResumeExisting);
}

/**
 * Run one physical agent turn under the logical-goal supervisor. Extracted
 * from `chat.tsx` (CR-006 pattern): recoverable-incomplete turns continue
 * automatically; an explicit `resumeExisting` restarts a genuinely paused
 * goal from its checkpoint/retry pool. Behavior is unchanged — pure code
 * motion over the explicit deps bundle.
 */
async function runSingleAgentTurn(deps: ChatScreenDeps, value: string, displayValue?: string, turnOptions: TurnExecutionOptions = {}, resumeExisting?: ResumeExisting) {
  const {
    stoppingRef, sealedRef, quarantineRef, activeGoalRef, conversationRef, settingsRef,
    sessionRecorderRef, contextFiles, settings, withDisplayOrder, addStreaming, patchLiveMessage,
    drainLiveMessages, finalizeMessage, setMessages, setBusy, setBusyLabel, debugLog,
    lastAssistantTextRef, abortControllerRef, workStateRef, setTokenUsage, setContextUsage, setFleet,
    setVisibleTasks, setTaskBarPadding, contextFileSignaturesRef, llmLogRef,
    showPersistenceWarning, setPausedResume, currentModelSelection, currentPromptSession,
  } = deps;
  if (stoppingRef.current) return;
  const sessionRecorder = sessionRecorderRef.current!;
  const selection = currentModelSelection();
  if (!selection) {
    setMessages(m => [...m, {role: 'system', text: 'No model selected for this session. Run /model to choose one.'}]);
    return;
  }
  sessionRecorder.recordModelSelection(selection);

  // The logical-goal supervisor owns this submission: recoverable-incomplete
  // physical turns (including step/tool budget boundaries) continue
  // automatically; per-turn limits stay safety boundaries. An explicit
  // resumeFrom restarts a genuinely paused goal from its checkpoint/pool.
  const goalOptions = {
    request: value,
    displayValue,
    contextFiles,
    session: currentPromptSession(),
    modelOverride: `${selection.provider}:${selection.model}`,
    escalationModel: settings.escalationModel,
    callbacks: {
    addMessage: (msg: import('../commands/streaming.js').Message) => {
      const ordered = withDisplayOrder(msg);
      if (ordered.streaming) {
        addStreaming(ordered);
        return;
      }
      finalizeMessage(ordered);
    },
    updateMessage: (id: string, update: Partial<import('../commands/streaming.js').Message>) => {
      if (patchLiveMessage(id, update)) return;
      setMessages(m => m.map(msg => msg.id === id ? {...msg, ...update} : msg));
    },
    setConversation: (msgs: import('ai').ModelMessage[]) => {
      conversationRef.current = msgs;
      sessionRecorder.recordConversation(msgs);
    },
    onModelTransition: (selector: string, msgs: import('ai').ModelMessage[]) => {
      const resolved = resolveModelSelector(settingsRef.current, selector);
      if (resolved.status === 'found') sessionRecorder.recordModelTransition(msgs, {provider: resolved.provider.name, model: resolved.model, endpointFingerprint: providerEndpointFingerprint(resolved.provider)});
    },
    setBusy,
    setBusyLabel,
    debugLog,
    getConversation: () => conversationRef.current,
    getLastAssistantText: () => lastAssistantTextRef.current,
    setLastAssistantText: (text: string) => { lastAssistantTextRef.current = text; },
    setAbortController: (controller: AbortController | null) => {
      abortControllerRef.current = controller;
      if (stoppingRef.current) controller?.abort('Chat is exiting.');
    },
    setWorkState: (state: import('../../core/agent/workState.js').WorkState) => {
      workStateRef.current = state;
      sessionRecorder.recordWorkState(state);
    },
    compactConversation: deps.sessionLifecycle.compactConversation,
    recordCompaction: (entry: Parameters<SessionRecorderLike['recordCompactEntry']>[0]) => sessionRecorder.recordCompactEntry(entry),
    recordTokenUsage: (usage: Parameters<typeof accumulateTokenUsage>[1]) => {
      setTokenUsage(current => accumulateTokenUsage(current, usage));
    },
    recordContextUsage: (tokens: number) => setContextUsage?.(current => ({windowTokens: current.windowTokens, usedTokens: tokens, estimated: false})),
    onEvent: (event: import('../../core/agent/events.js').AgentEvent) => {
      sessionRecorder.recordEvent(event);
      if (event.type === 'context_budget') setContextUsage?.(current => ({...current, windowTokens: event.contextWindowTokens}));
      else if (event.type === 'subagent_state') setFleet(current => nextFleetStatus(current, event));
      else if (event.type === 'goal_end') setFleet(undefined);
    },
    onTasksChanged: () => { loadTasksFromStore().then(t => {
      if (stoppingRef.current) return;
      setVisibleTasks(t); setTaskBarPadding(0);
    }).catch(() => undefined); },
    contextFileSignatures: contextFileSignaturesRef.current,
    log: llmLogRef.current,
    },
    ...(resumeExisting ? {resumeFrom: resumeExisting} : {}),
    // Durable goal ledger (P1): every supervisor boundary appends to the
    // session JSONL so a crash or restart leaves a resumable frontier.
    goalLedger: {append: (entry: unknown) => { if (!sealedRef.current) sessionRecorder.recordGoalEntry(entry as never); }},
    ...(turnOptions.attachments || turnOptions.blessedPaths || turnOptions.ephemeralControl || turnOptions.subagentOverrides ? {turnOptions} : {})} satisfies Parameters<typeof runAgentGoal>[0];
  const guarded = createQuarantinableCallbacks(goalOptions.callbacks);
  quarantineRef.current = guarded.quarantine;
  const goalPromise = runAgentGoal({...goalOptions, callbacks: guarded.callbacks});
  activeGoalRef.current = goalPromise;
  const goalResult = await goalPromise;
  activeGoalRef.current = undefined;
  if (stoppingRef.current) return goalResult;
  await sessionRecorder.flush().catch(showPersistenceWarning);
  await llmLogRef.current?.writer?.flush().catch(showPersistenceWarning);
  // Turn boundary: an aborted or forcibly-settled attempt is quarantined
  // before it can emit the finalizing update, so settle anything still in
  // the live tail now; the streamed text is preserved verbatim in <Static>.
  drainLiveMessages();
  // Only a genuinely paused goal (supervisor already attempted automatic
  // continuation) exposes the one-key resume affordance; it stays until the
  // user submits something else.
  if (goalResult.resume?.kind === 'model-stream-idle') setPausedResume({kind: 'model-stream-idle', request: goalResult.resume.request, retryAttempt: goalResult.resume.retryAttempt});
  else if (goalResult.resume?.kind === 'incomplete-goal') setPausedResume({kind: 'incomplete-goal', request: goalResult.resume.checkpoint.request, retryAttempt: 0, checkpoint: goalResult.resume.checkpoint, pauseReason: goalResult.stopReason === 'context-exhausted' || goalResult.stopReason === 'goal-deadline' || goalResult.stopReason === 'no-progress' ? goalResult.stopReason : undefined});
  else setPausedResume(undefined);
  return goalResult;
}

type SessionRecorderLike = NonNullable<ChatScreenDeps['sessionRecorderRef']['current']>;
