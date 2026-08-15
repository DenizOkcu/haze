import {ToolLoopAgent, isStepCount, type ModelMessage, type ToolSet} from 'ai';
import type {LlmLog} from '../../core/log/llmLog.js';
import {appendLogEntry as logAppend, type LlmLogEntry} from '../../core/log/llmLog.js';
import {modelWithConfig, providerRequestSettings} from '../../llm/client.js';
import {assembleRequestContext, type SubagentOverrides, type TurnExecutionScope} from '../../llm/requestContext.js';
import {projectContextSection, type PromptSession} from '../../llm/systemPrompt.js';
import {closeMcpClients, type LoadedMcpTools} from '../../llm/mcp.js';
import type {LspPool} from '../../llm/lsp/pool.js';
import type {ContextFile} from '../../config/contextFiles.js';
import {readSettings} from '../../config/settings.js';
import {toolCallSummary, toolResultSummary, busyToolLabel, formatSeconds} from './formatters.js';
import {agentEvent, type AgentEventSink} from '../../core/agent/events.js';
import {isContextOverflowError, isRetryableModelError} from '../../core/agent/errors.js';
import {isPlanOnlyRequest} from '../../core/agent/goalPolicy.js';
import {userTurnMessage, type ImageAttachment} from '../../core/attachments/imageAttachments.js';
import {type BlessedPath} from '../../core/attachments/readBlessings.js';
import {malformedToolCallPrompt, repeatedToolCallPrompt, toolLoopBudgetPrompt, lengthContinuationPrompt, completionRescuePrompt, goalContinuationPrompt} from '../../core/agent/goalPolicy.js';
import {calculateRequestTokenBudget, estimateMessagesTokens, estimateValueTokens} from '../../core/agent/contextBudget.js';
import {compactToolHistory, stripSyntheticControls, withSyntheticControl, withoutSystemMessages} from '../../core/agent/requestAssembly.js';
import {isDuplicateSkippedOutput, safeToolFailureDetails, toolOutputOk} from '../../core/agent/toolResults.js';
import {latestRepeatedToolNames, toolOnlyStepCount} from '../../core/agent/turnPolicy.js';
export {latestRepeatedToolNames, uniqueRepeatedToolNames, toolOnlyStepCount} from '../../core/agent/turnPolicy.js';
import {compactModelMessages} from '../../core/agent/compaction.js';
import {clampSlice, createToolExecutionBudget, isToolBudgetBlocked, mainTurnBudget, remainingSteps, remainingToolCalls, withToolExecutionBudget, DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_TOOL_DEADLINE_MS, DEFAULT_TURN_DEADLINE_MS, IDLE_TIMEOUT_MS, MAIN_STEP_LIMIT, MAIN_TOOL_CALL_LIMIT, SUBAGENT_TOOL_DEADLINE_MS, WRITE_FILE_CHUNK_BYTES, type ToolExecutionBudgetState, type TurnBudget} from '../../core/agent/budgets.js';
import {createTurnExecutionState, assessCompletionReadiness, classifyTerminalOutcome, decideGoalContinuation, decideLengthRecovery, decideRescue, describeCompletionReadiness, goalContinuationRecoverable, isBudgetExhausted, normalizeFinishReason, recordGoalContinuation, rescueEligibleRequest, RESCUE_BOUNDARY, toCompletionEvidence, type CompletionEvidence, type TerminalClassification, type TurnCompletionEvidence, type TurnExecutionState} from '../../core/agent/completionController.js';
export type {TurnCompletionEvidence} from '../../core/agent/completionController.js';
import {createAbsoluteDeadline, isToolDeadlineExceeded, withToolDeadline, type AbsoluteDeadline} from '../../core/deadline.js';
import {isMutatingCapability, isValidationCapable} from '../../core/agent/toolCapabilities.js';
import {deriveValidationOutcome, seedCarriedGoalEvidence, type ValidationOutcome, type WorkTaskProgress} from '../../core/agent/workState.js';
import {createSessionGoal, formatGoalStatus, observeGoalToolEvent, type SessionGoal} from '../../core/agent/goalPolicy.js';
import type {WorkState} from '../../core/agent/workState.js';
import {buildIncompleteGoalResume, type IncompleteGoalResume} from './streaming/goalCheckpoint.js';
import {sanitizeAssistantText, assistantDisplayText, normalizeAssistantText, shouldStartAssistantStream, isHiddenAssistantFragment, isHiddenUnstartedFinalText, isShortLeadInBeforeTool, isShortUnfinishedLeadIn} from './streaming/assistantText.js';
import {createToolGroupRenderer, toolDiffFromResult, type NativeToolCall, type ToolDisplayDiff} from './streaming/toolGroupRenderer.js';
import {applyStepToolResultState, initialToolResultState} from './streaming/toolResultState.js';
import {abortableDelay, estimateInputBreakdown, extractUsage, rememberContextFilesFromToolOutput, responseCompletionMetrics, retryDelayMs, stepCacheMetrics, subagentTokenEstimate, type TokenUsage} from './streaming/turnRuntime.js';
import {toolsContextFor, type HazeToolContext} from '../../llm/tools/toolContext.js';
import {modelThinkingLabel} from '../../utils/modelName.js';
import {terminalTurnStatus} from './streaming/turnOutcome.js';
import {createIdleTimer} from './streaming/idleTimer.js';
import {abortForTurn, createUserAbortCause, type TurnAbortCause} from './streaming/abortCause.js';
import {clampOutOfBoundsToolNumbers, isMalformedToolInputError} from './streaming/toolCallRecovery.js';
import {WorkspaceMutationPolicy} from '../../core/subagent/workspaceMutationPolicy.js';
export type {TokenUsage} from './streaming/turnRuntime.js';

export type Message = {id?: string; role: 'system' | 'user' | 'assistant' | 'tool'; text: string; streaming?: boolean; hidden?: boolean; startedAt?: number; finishedAt?: number; tokensPerSecond?: number; displayOrder?: number; toolCount?: number; toolDiffs?: ToolDisplayDiff[]};

export type TurnStatus = 'complete' | 'aborted' | 'failed';

/** Authoritative outcome of a turn, so callers (esp. headless/CI) need not sniff message text. */
export interface TurnResult {
  status: TurnStatus;
  /** Bounded, safe completion evidence (no raw commands/output). Additive. */
  evidence?: TurnCompletionEvidence;
  /**
   * The turn paused with recoverable work unfinished; this carries what a
   * one-key/automatic resume needs instead of forcing the user to restate the
   * task. Safe metadata only (reasons, counts, enums) — never commands,
   * content, or credentials.
   *
   * - `model-stream-idle`: the model stream stalled past the idle window and
   *   bounded retries could not continue. The conversation keeps completed
   *   steps; resume continues the same logical turn's retry pool.
   * - `incomplete-goal`: the attempt ended `recoverable-incomplete` (declared
   *   tasks or post-edit validation outstanding) with no same-turn recovery
   *   available — including step/tool budget boundaries that finish as
   *   `tool-calls`. A goal supervisor (or the interactive R key) continues the
   *   logical goal in a fresh physical turn against the preserved
   *   conversation; completed mutations are never replayed.
   */
  resume?: {kind: 'model-stream-idle'; request: string; retryAttempt: number} | IncompleteGoalResume;
}

/** Supervisor-provided logical-goal context: tags checkpoints and seeds cumulative evidence. */
interface TurnGoalContext {
  goalId: string;
  /** 1-based physical-turn counter for the logical goal. */
  cycle: number;
  /** Cumulative evidence carried from earlier physical turns. */
  carried: {mutationCount: number; validationOutcome: ValidationOutcome; taskProgress?: WorkTaskProgress};
  /** Consecutive no-progress physical turns at goal level (diagnostics). */
  noProgressCount: number;
}

export interface TurnExecutionOptions {
  ephemeralControl?: string;
  subagentOverrides?: SubagentOverrides;
  /** User-attached images for this turn (F03); only the first attempt carries them. */
  attachments?: readonly ImageAttachment[];
  /** User-mentioned paths whose reads may escape workspace confinement this turn. */
  blessedPaths?: readonly BlessedPath[];
  /** When set, this attempt is a bounded recovery slice (length-continuation, rescue, or goal continuation). */
  recoverySlice?: {kind: 'length' | 'rescue' | 'goal'; maxSteps: number; maxToolCalls: number};
  /** Absolute turn deadline in milliseconds (headless `--timeout`); defaults to DEFAULT_TURN_DEADLINE_MS. */
  turnDeadlineMs?: number;
  /** Logical-goal context from the goal supervisor; hydrates cumulative evidence so a fresh physical turn cannot complete while carried work remains. */
  goalContext?: TurnGoalContext;
  /** Shared turn scope (coordinator admission + workspace mutation lease) reused across a logical goal's physical turns. */
  sharedTurnScope?: {executionScope?: TurnExecutionScope};
}

type NativeToolFinish = {toolCall: NativeToolCall; success: boolean; output?: unknown; error?: unknown; durationMs: number};

function logEntry(log: LlmLog | undefined, entry: LlmLogEntry) {
  if (log) void logAppend(log, entry).catch(() => undefined);
}

function withScopedContextControl(messages: ModelMessage[], context: HazeToolContext): ModelMessage[] {
  const files = context.pendingContextFiles ?? [];
  if (files.length === 0) return messages;
  context.pendingContextFiles = [];
  return withSyntheticControl(
    messages,
    `Additional scoped project instructions were just read for a non-root path touched by a tool call. Apply them to subsequent work in that subtree.${projectContextSection(files)}`,
  );
}

/**
 * Restrict a tool set to the capabilities permitted in a completion-rescue
 * slice: mutation (edit/write/replace) and validation-capable (bash) built-in
 * tools only. Discovery, read, coordinate, and all third-party (MCP) tools are
 * dropped so the rescue cannot reopen exploration. May return an empty set
 * when no built-in mutation/validation tools exist (only possible if builtins
 * were removed); the caller then forces a tool-free synthesis slice instead
 * of silently keeping the unfiltered tool set (F-08).
 */
export function restrictToRescueTools(tools: ToolSet): ToolSet {
  const restricted: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (isMutatingCapability(name) || isValidationCapable(name)) restricted[name] = tool;
  }
  return restricted;
}

export interface StreamCallbacks {
  addMessage: (msg: Message) => void;
  updateMessage: (id: string, update: Partial<Message>) => void;
  setConversation: (messages: ModelMessage[]) => void;
  setBusy: (busy: boolean) => void;
  setBusyLabel?: (label: string) => void;
  debugLog: (line: string) => void;
  getConversation: () => ModelMessage[];
  getLastAssistantText: () => string;
  setLastAssistantText: (text: string) => void;
  setAbortController?: (controller: AbortController | null) => void;
  setGoalStatus?: (status: string | undefined) => void;
  onEvent?: AgentEventSink;
  compactConversation?: (instructions?: string) => boolean;
  recordTokenUsage?: (usage: TokenUsage) => void;
  setWorkState?: (state: WorkState) => void;
  onTasksChanged?: () => void;
  log?: LlmLog;
  contextFileSignatures?: Map<string, string>;
}

type AgentAttemptResult = TurnResult & {
  retry?: {attempt: number; contextOverflowRecovered: boolean; delayMs: number; /** The retry aborts the previous controller (idle stall); hand the loop a fresh one. */ freshController?: boolean};
  /** When set, run one bounded recovery slice next (length-continuation, rescue, or goal continuation). */
  recovery?: {kind: 'length' | 'rescue' | 'goal'; control: string; slice: {maxSteps: number; maxToolCalls: number}};
};

/** Shared bounded retry pool for transient model errors and idle-stream stalls (per turn). */
const MAX_MODEL_RETRIES = 2;

function formatIdleMinutes(milliseconds: number) {
  const minutes = Math.round(milliseconds / 60_000);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** Auto-retry an idle stall only while the stalled step emitted nothing visible (no partial text or in-flight tool). */
function idleStallAutoRetryEligible(retryAttempt: number, stallEmission: 'none' | 'text' | 'tool') {
  return stallEmission === 'none' && retryAttempt < MAX_MODEL_RETRIES;
}

async function runAgentAttempt(
  value: string,
  contextFiles: ContextFile[],
  callbacks: StreamCallbacks,
  retryAttempt: number,
  retryingExistingRequest: boolean,
  contextOverflowRecovered: boolean,
  session: PromptSession | undefined,
  modelOverride: string | undefined,
  abortController: AbortController,
  turnOptions: TurnExecutionOptions,
  turnScope: {executionScope?: TurnExecutionScope},
  turnState: TurnExecutionState,
  turnBudget: TurnBudget,
  globalBudget: ToolExecutionBudgetState,
  goal: SessionGoal,
  abortCause: TurnAbortCause,
  remainingTurnDeadlineMs: () => number,
): Promise<AgentAttemptResult> {
  let thinkingLabel = modelThinkingLabel(undefined);
  callbacks.setBusyLabel?.(thinkingLabel);
  let turnStatus: TurnStatus = 'failed';
  let recovery: AgentAttemptResult['recovery'];
  let loadedMcp: LoadedMcpTools | undefined;
  let lspPool: LspPool | undefined;
  // Tool calls currently executing. A concurrent subagent wave can run for many
  // minutes with no stream parts; that is activity, not a dead stream, so the
  // idle timer defers while any tool is in flight (see streaming/idleTimer.ts).
  const inFlightTools = new Set<string>();
  // Hoisted stall/abort state: the idle timer's onTimeout and the catch below
  // must classify a stall from stream state that is otherwise scoped to the try
  // block below. requestMessages/accumulated responses enable the salvage that
  // lets an idle retry resume from the last fully completed step.
  let activeProviderName: string | undefined;
  let activeModelName: string | undefined;
  let lastStreamEventAt: number | undefined;
  let lastStreamEventType: string | undefined;
  let idleStallEmission: 'none' | 'text' | 'tool' = 'none';
  let idleStallRetryEligible = false;
  let requestMessages: ModelMessage[] = [];
  let latestAccumulatedResponseMessages: ModelMessage[] = [];
  let currentAssistantText = '';
  let assistantStarted = false;
  const idleTimer = createIdleTimer({
    timeoutMs: IDLE_TIMEOUT_MS,
    isBusy: () => inFlightTools.size > 0,
    onTimeout: () => {
      if (abortController.signal.aborted) return;
      // What the stalled step had emitted when the stream went quiet. Retrying
      // after partial output could duplicate or mangle it, so only 'none' is
      // automatically retryable.
      idleStallEmission = currentAssistantText.trim().length > 0 || assistantStarted ? 'text' : inFlightTools.size > 0 ? 'tool' : 'none';
      idleStallRetryEligible = idleStallAutoRetryEligible(retryAttempt, idleStallEmission);
      const lastEventAtIso = lastStreamEventAt != null ? new Date(lastStreamEventAt).toISOString() : undefined;
      // Safe metadata only (names, timestamps, enums, phases): never prompt
      // content or credentials.
      callbacks.onEvent?.(agentEvent({
        type: 'timeout',
        phase: 'model-stream',
        timeoutMs: IDLE_TIMEOUT_MS,
        provider: activeProviderName,
        model: activeModelName,
        lastStreamEventAt: lastEventAtIso,
        lastStreamEventType: lastStreamEventType,
        stallEmission: idleStallEmission,
        workPhase: goal.phase,
        retryEligible: idleStallRetryEligible,
      }));
      logEntry(callbacks.log, {at: new Date().toISOString(), type: 'warning', stream: 'main', error: `model-stream idle ${IDLE_TIMEOUT_MS}ms: provider=${activeProviderName ?? 'unknown'} model=${activeModelName ?? 'unknown'} lastEvent=${lastStreamEventType ?? 'none'}@${lastEventAtIso ?? 'never'} stallEmission=${idleStallEmission} workPhase=${goal.phase} retryEligible=${idleStallRetryEligible} stepsUsed=${turnState.stepsUsed}`});
      callbacks.debugLog(`model stream idle for ${IDLE_TIMEOUT_MS}ms (last event: ${lastStreamEventType ?? 'none'}); ${idleStallRetryEligible ? 'retryable stall' : 'stall not retryable'}`);
      abortForTurn(abortCause, {kind: 'model-stream-idle', timeoutMs: IDLE_TIMEOUT_MS}, abortController, 'haze model stream was idle for the configured timeout.');
    },
  });

  const toolDisplay = createToolGroupRenderer({addMessage: callbacks.addMessage, updateMessage: callbacks.updateMessage, debugLog: callbacks.debugLog, onEvent: callbacks.onEvent, log: callbacks.log});

  try {
    // Single choke point: one fresh settings read per turn, shared by model
    // resolution and request assembly (CR-024).
    const turnSettings = await readSettings();
    const runtime = await modelWithConfig({cwd: session?.cwd, modelSelector: modelOverride}, turnSettings);
    if (!runtime?.model) {
      callbacks.addMessage({role: 'assistant', text: 'No model provider configured. Run /provider to choose or add a provider. haze cannot hallucinate without a model. Progress.'});
      turnStatus = 'failed';
      return {status: turnStatus};
    }

    thinkingLabel = modelThinkingLabel(runtime.config.modelName);
    activeProviderName = runtime.config.providerName;
    activeModelName = runtime.config.modelName;
    callbacks.setBusyLabel?.(thinkingLabel);
    // Observable requested-vs-effective reasoning policy (safe: level strings + reason only).
    const reasoningPolicy = runtime.config.reasoningPolicy;
    if (reasoningPolicy) callbacks.onEvent?.(agentEvent({type: 'reasoning_policy', requested: reasoningPolicy.requested, effective: reasoningPolicy.effective, reason: reasoningPolicy.reason}));
    // Make the context-budget guess observable: a stream event every turn
    // (headless consumers can gate on it), and — interactively — a system
    // message only when the built-in default was used for a model this session
    // has not warned about yet (a user-set fallback setting is an intentional
    // choice and is not warned about). The warned key is `provider:model`, so
    // the message appears at the start of a session and once after a model
    // switch, never on every turn.
    callbacks.onEvent?.(agentEvent({type: 'context_budget', contextWindowTokens: runtime.config.contextWindowTokens, source: runtime.config.contextWindowSource}));
    const fallbackModelKey = `${runtime.config.providerName}:${runtime.config.modelName}`;
    if (runtime.config.contextWindowSource === 'default-fallback' && session && session.contextFallbackWarned !== fallbackModelKey) {
      session.contextFallbackWarned = fallbackModelKey;
      callbacks.addMessage({role: 'system', text: `No context-window data for ${runtime.config.providerName}:${runtime.config.modelName}; budgeting conservatively at ${runtime.config.contextWindowTokens.toLocaleString('en-US')} tokens. Set modelLimits for this model via /provider, or contextWindowFallbackTokens in settings, to use its real window.`});
    }

    let activeContextFiles = contextFiles;
    const activeModel = runtime.model;
    const {omitMaxOutputTokens, ...providerSettings} = providerRequestSettings(runtime.config);
    const assembled = await assembleRequestContext({contextFiles: activeContextFiles, session, model: activeModel, modelRuntime: runtime, subagentOverrides: turnOptions.subagentOverrides, abortSignal: abortController.signal, executionScope: turnScope.executionScope, settings: turnSettings, onSubagentEvent: event => callbacks.onEvent?.(agentEvent(event.type === 'queued'
      ? {type: 'subagent_state', id: event.id, state: 'queued', mode: event.mode, queued: event.queued, running: event.running}
      : event.type === 'started'
        ? {type: 'subagent_state', id: event.id, state: 'started', mode: event.mode, queueMs: event.queueMs, running: event.running}
        : event.type === 'terminal'
          ? {type: 'subagent_state', id: event.id, state: 'terminal', mode: event.mode, queueMs: event.queueMs, durationMs: event.durationMs, termination: event.termination, execution: event.execution, running: event.running}
          : {type: 'subagent_state', id: event.id, state: 'settled', mode: event.mode, queueMs: event.queueMs, durationMs: event.durationMs, termination: event.termination, execution: 'settled', running: event.running}))});
    turnScope.executionScope ??= assembled.executionScope;
    const availableTools = assembled.availableTools;
    const toolCategories = assembled.toolCategories;
    loadedMcp = assembled.loadedMcp;
    lspPool = assembled.lspPool;
    if (loadedMcp?.errors.length) callbacks.addMessage({role: 'system', text: `MCP: ${loadedMcp.errors.join('; ')}`});

    callbacks.setWorkState?.(goal);
    callbacks.setGoalStatus?.(formatGoalStatus(goal));
    const likelyPlanOnlyRequest = isPlanOnlyRequest(value);

    const durableRequestMessages = compactToolHistory(
      retryingExistingRequest
        ? stripSyntheticControls(callbacks.getConversation())
        : [...stripSyntheticControls(callbacks.getConversation()), userTurnMessage(value, turnOptions.attachments ?? [])],
    ).messages;
    // Model-aware request budget (RH-005): message allowance is the context
    // window minus system prompt, tool schemas, output reserve, and a safety
    // margin — not a fixed 40K constant. Small contexts get a safe budget; the
    // assembled request plus output reserve stays within configured capacity.
    const requestedOutputTokens = runtime.config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const requestBudget = calculateRequestTokenBudget({contextWindowTokens: runtime.config.contextWindowTokens, requestedOutputTokens, system: assembled.systemPrompt, tools: availableTools});
    // A context-overflow retry progressively shrinks the target so it cannot loop
    // at an unchanged budget; further overflows get even smaller (RH-005).
    const overflowTargetTokens = contextOverflowRecovered ? Math.floor(requestBudget.messageTokens * 0.6) : requestBudget.messageTokens;
    requestMessages = durableRequestMessages;
    if (estimateMessagesTokens(requestMessages) > overflowTargetTokens) {
      requestMessages = compactModelMessages(requestMessages, {tokenBudget: overflowTargetTokens, workState: goal}).messages;
    }
    requestMessages = withoutSystemMessages(requestMessages);
    callbacks.setConversation(stripSyntheticControls(requestMessages));
    if (turnOptions.ephemeralControl) requestMessages = withSyntheticControl(requestMessages, turnOptions.ephemeralControl);

    const systemPrompt = assembled.systemPrompt;
    const inputBreakdown = estimateInputBreakdown({system: systemPrompt, contextFiles: activeContextFiles, messages: requestMessages, tools: availableTools});
    logEntry(callbacks.log, {at: new Date().toISOString(), type: 'request', stream: 'main', system: systemPrompt, messages: requestMessages, tools: Object.keys(availableTools), context: inputBreakdown.breakdown});

    const previousAssistantText = normalizeAssistantText(callbacks.getLastAssistantText());
    const visibleAssistantTexts = new Set(previousAssistantText ? [previousAssistantText] : []);
    const rememberVisibleAssistantText = (text: string) => {
      const normalized = normalizeAssistantText(text);
      if (!normalized) return;
      visibleAssistantTexts.add(normalized);
      callbacks.setLastAssistantText(text);
    };

    const contextFileSignatures = callbacks.contextFileSignatures ?? new Map(activeContextFiles.flatMap(file => file.signature ? [[file.path, file.signature] as const] : []));
    const mutationPolicy = assembled.executionScope?.mutationPolicy ?? new WorkspaceMutationPolicy();
    const toolExecutionContext: HazeToolContext = {inFlightToolCalls: new Map<string, Promise<unknown>>(), loadedContextFilePaths: new Set(activeContextFiles.map(file => file.path)), loadedContextFileSignatures: contextFileSignatures, onContextFileRead: path => toolDisplay.addContextFileRead(path), mutationPolicy, blessedPaths: turnOptions.blessedPaths};
    const startedTools = new Map<string, number>();
    const latestToolCalls = new Map<string, NativeToolCall>();
    let currentAssistantId = `assistant-${Date.now()}`;
    let assistantStartedAt = Date.now();
    let assistantText = '';
    let streamError: unknown;
    let streamFinished = false;
    let finishReason: string | undefined;
    let lastToolOk: boolean | undefined;
    let pendingMalformedToolName: string | undefined;
    let unresolvedMalformedToolName: string | undefined;
    // Per-attempt (not per-turn) recovery counter: a transient retry gets a
    // fresh map. Bounded across the whole turn by MAIN_TOOL_CALL_LIMIT.
    const malformedRecoveryAttempts = new Map<string, number>();
    let toolResultState = initialToolResultState();
    const resetAssistantSegment = () => {
      currentAssistantId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      assistantStarted = false;
      assistantStartedAt = Date.now();
      currentAssistantText = '';
    };
    const finalizeAssistantSegment = (options: {beforeTool?: boolean} = {}) => {
      const finalText = assistantDisplayText(currentAssistantText);
      const normalized = normalizeAssistantText(finalText);
      const hidden = (assistantStarted ? isHiddenAssistantFragment(finalText) : isHiddenUnstartedFinalText(finalText))
        || (options.beforeTool === true && isShortLeadInBeforeTool(finalText))
        || (options.beforeTool !== true && isShortUnfinishedLeadIn(finalText))
        || (normalized.length > 0 && visibleAssistantTexts.has(normalized));
      if (assistantStarted) {
        if (!hidden) rememberVisibleAssistantText(finalText);
        callbacks.onEvent?.(agentEvent({type: 'message_end', id: currentAssistantId, text: finalText, hidden}));
        callbacks.updateMessage(currentAssistantId, {text: finalText, streaming: false, hidden, ...responseCompletionMetrics(finalText, assistantStartedAt)});
      } else if (!hidden) {
        if (!hidden) rememberVisibleAssistantText(finalText);
        callbacks.onEvent?.(agentEvent({type: 'message_start', id: currentAssistantId, role: 'assistant'}));
        callbacks.onEvent?.(agentEvent({type: 'message_end', id: currentAssistantId, text: finalText, hidden: false}));
        callbacks.addMessage({id: currentAssistantId, role: 'assistant', text: finalText, streaming: false, startedAt: assistantStartedAt, ...responseCompletionMetrics(finalText, assistantStartedAt)});
      }
      resetAssistantSegment();
      return !hidden;
    };

    const recoverySlice = turnOptions.recoverySlice;
    const stepCap = recoverySlice?.maxSteps ?? MAIN_STEP_LIMIT;
    // Rescue exposes only mutation + validation-capable built-in tools so
    // discovery cannot be reopened near the boundary. Length-continuation keeps
    // the full tool set. When no built-in mutation/validation tool qualifies,
    // the rescue slice runs tool-free (forced synthesis) rather than keeping
    // the unfiltered set — the "discovery must not be reopened" invariant (F-08).
    const rescueTools = recoverySlice?.kind === 'rescue' ? restrictToRescueTools(availableTools) : availableTools;
    const rescueWithoutTools = recoverySlice?.kind === 'rescue' && Object.keys(rescueTools).length === 0;
    const sliceTools: ToolSet = rescueWithoutTools ? {} : rescueTools;
    // Execution-boundary budgets (RH-003). The global budget is turn-wide
    // (shared across retries and recovery slices); the slice budget is
    // per-attempt and caps a recovery slice. Both are checked atomically at the
    // actual execute boundary so one oversized parallel batch cannot overshoot.
    const sliceBudget = createToolExecutionBudget();
    const sliceToolCallCap = recoverySlice?.maxToolCalls ?? MAIN_TOOL_CALL_LIMIT;
    const budgetedTools = withToolExecutionBudget(sliceTools, {state: globalBudget, limit: turnBudget.toolCallLimit}, {state: sliceBudget, limit: sliceToolCallCap});
    // Layer a per-tool execution deadline on top of the budget (RH-004). The
    // budget is checked first (cheap); a permitted call then runs under a
    // deadline so an uncooperative tool cannot defer the turn indefinitely.
    // Subagents legitimately run long, so their wrapper gets a larger bound.
    const deadlineWrappedTools = Object.fromEntries(Object.entries(budgetedTools).map(([name, definition]) => {
      if (typeof definition.execute !== 'function') return [name, definition];
      const execute = definition.execute as unknown as (...args: unknown[]) => Promise<unknown>;
      const deadlineMs = name === 'subagent' ? SUBAGENT_TOOL_DEADLINE_MS : DEFAULT_TOOL_DEADLINE_MS;
      return [name, {...definition, execute: (...args: unknown[]) => withToolDeadline(() => execute(...args), deadlineMs, abortController.signal)}];
    })) as typeof budgetedTools;

    const agent = new ToolLoopAgent({
      id: 'haze-main',
      model: activeModel,
      instructions: systemPrompt,
      tools: deadlineWrappedTools,
      ...(!omitMaxOutputTokens ? {maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS} : {}),
      ...providerSettings,
      stopWhen: isStepCount(stepCap),
      runtimeContext: toolExecutionContext,
      toolsContext: toolsContextFor(deadlineWrappedTools, toolExecutionContext) as never,
      experimental_repairToolCall: async ({toolCall, error, inputSchema}) => {
        if (isMalformedToolInputError(error)) {
          const clamped = await clampOutOfBoundsToolNumbers(toolCall.input, toolCall.toolName, inputSchema);
          if (clamped != null) {
            callbacks.debugLog(`clamped out-of-range numeric input for ${toolCall.toolName}; executing repaired call`);
            return {type: 'tool-call' as const, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input: JSON.stringify(clamped)};
          }
          pendingMalformedToolName = toolCall.toolName;
          unresolvedMalformedToolName = toolCall.toolName;
        }
        // Truncated generated file content cannot be reconstructed safely here;
        // let the next agent step retry under the bounded tool-choice constraint.
        return null;
      },
      prepareStep({steps, messages}) {
        // A rescue slice with no qualifying tools must synthesize, never reopen
        // discovery by falling back to the full tool set (F-08).
        if (rescueWithoutTools) {
          callbacks.debugLog('rescue slice has no mutation/validation tools; forcing tool-free synthesis');
          return {toolChoice: 'none' as const};
        }
        const toolCalls = steps.flatMap(step => step.toolCalls);
        const repeatedToolNames = latestRepeatedToolNames(steps);
        let scopedMessages = withScopedContextControl(messages, toolExecutionContext);
        let messagesChanged = scopedMessages !== messages;
        // Re-evaluate the accumulated request size before each provider call and
        // compact old tool history when it exceeds the model-aware budget, so a
        // long multi-step turn compacts before overflowing (RH-005).
        if (estimateMessagesTokens(scopedMessages) > requestBudget.messageTokens) {
          const compacted = compactModelMessages(stripSyntheticControls(scopedMessages), {tokenBudget: requestBudget.messageTokens, workState: goal}).messages;
          scopedMessages = compacted;
          messagesChanged = true;
        }
        // Turn-wide hard caps (shared across retries and recovery slices).
        const turnToolCallsExhausted = turnState.toolCallsUsed >= turnBudget.toolCallLimit;
        // Per-slice tool-call cap for a recovery slice (counts this slice's calls).
        const sliceToolCallsExhausted = recoverySlice ? toolCalls.length >= recoverySlice.maxToolCalls : false;
        // Reserve the final tool-only slot for rescue: normal exploration stops at
        // the boundary; a rescue slice is exempt so it may use the reserved slot.
        const toolOnlyBoundaryHit = !recoverySlice && toolOnlyStepCount(steps) >= RESCUE_BOUNDARY;
        if (likelyPlanOnlyRequest && toolResultState.mutatingToolSucceeded) return messagesChanged ? {toolChoice: 'none' as const, messages: scopedMessages} : {toolChoice: 'none' as const};
        if (pendingMalformedToolName && pendingMalformedToolName in sliceTools) {
          const toolName = pendingMalformedToolName as keyof typeof sliceTools;
          const attempt = malformedRecoveryAttempts.get(String(toolName)) ?? 0;
          pendingMalformedToolName = undefined;
          if (attempt >= 2) {
            callbacks.debugLog(`malformed ${String(toolName)} recovery exhausted`);
            return {toolChoice: 'none' as const, messages: withSyntheticControl(scopedMessages, `The ${String(toolName)} input remained invalid after two smaller retries. Report this as blocked; do not promise another retry or claim completion.`)};
          }
          malformedRecoveryAttempts.set(String(toolName), attempt + 1);
          callbacks.debugLog(`forcing smaller retry after malformed ${String(toolName)} input`);
          // OpenAI-compatible servers differ in tool_choice support: several
          // (LM Studio, llama.cpp) accept only the string form (none/auto/
          // required) and reject the object form with HTTP 400. Narrowing to a
          // single active tool plus 'required' preserves the forced-call
          // semantics on every server.
          return {activeTools: [toolName] as Array<keyof typeof sliceTools>, toolChoice: 'required' as const, messages: withSyntheticControl(scopedMessages, malformedToolCallPrompt(String(toolName), WRITE_FILE_CHUNK_BYTES))};
        }
        if (toolResultState.editRecoveryPath && !toolResultState.editRecoveryReadSatisfied) {
          if ('readFile' in sliceTools) return messagesChanged ? {activeTools: ['readFile'] as Array<keyof typeof sliceTools>, messages: scopedMessages} : {activeTools: ['readFile'] as Array<keyof typeof sliceTools>};
          return {toolChoice: 'none' as const, messages: withSyntheticControl(scopedMessages, `The failed mutation of ${toolResultState.editRecoveryPath} requires a fresh read, but readFile is unavailable in this bounded recovery slice. Report the unfinished edit as blocked; do not claim it succeeded.`)};
        }
        if (repeatedToolNames.length > 0) {
          const activeTools = (Object.keys(sliceTools) as Array<keyof typeof sliceTools>).filter(name => !repeatedToolNames.includes(name as string));
          callbacks.debugLog(`disabling repeated tools for next step: ${repeatedToolNames.join(', ')}`);
          return activeTools.length > 0
            ? {activeTools, messages: withSyntheticControl(scopedMessages, repeatedToolCallPrompt(repeatedToolNames))}
            : {toolChoice: 'none', messages: withSyntheticControl(scopedMessages, repeatedToolCallPrompt(repeatedToolNames))};
        }
        if (turnToolCallsExhausted || sliceToolCallsExhausted || toolOnlyBoundaryHit || toolCalls.length >= MAIN_TOOL_CALL_LIMIT) {
          callbacks.debugLog('forcing text response to avoid tool loop');
          return {toolChoice: 'none', messages: withSyntheticControl(scopedMessages, toolLoopBudgetPrompt())};
        }
        return messagesChanged ? {messages: scopedMessages} : undefined;
      },
      onStepStart({stepNumber}) {
        callbacks.onEvent?.(agentEvent({type: 'step_start', attempt: retryAttempt + 1, step: stepNumber + 1}));
      },
      onStepEnd({stepNumber, text, content = [], toolCalls, toolResults, finishReason, usage, response}) {
        // Tool-loop control must advance from this internal callback, which the
        // SDK awaits before prepareStep. Updating it from the public stream can
        // lag behind fast providers and leave the next request read-only.
        toolResultState = applyStepToolResultState(toolResultState, content);
        // Turn-wide counters (shared across provider retries and recovery
        // slices) so the global budget cannot reset between attempts. The
        // execution-boundary budget (RH-003) is the authoritative count of
        // underlying executions; sync the turn state to it so blocked calls are
        // not double-counted and recovery math stays consistent.
        turnState.stepsUsed += 1;
        turnState.toolCallsUsed = globalBudget.started;
        if (toolCalls.length > 0 && text.trim().length === 0) turnState.toolOnlyStepsUsed += 1;
        if (Array.isArray(response?.messages) && response.messages.length > 0) latestAccumulatedResponseMessages = response.messages as ModelMessage[];
        const stepUsage = stepCacheMetrics(usage);
        const publicUsage = {
          inputTokens: stepUsage.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          cacheReadTokens: stepUsage.cacheReadTokens,
          cacheWriteTokens: stepUsage.cacheWriteTokens,
          reasoningTokens: stepUsage.reasoningTokens,
        };
        callbacks.onEvent?.(agentEvent({type: 'step_end', attempt: retryAttempt + 1, step: stepNumber + 1, finishReason, toolCallCount: toolCalls.length, usage: publicUsage}));
        logEntry(callbacks.log, {at: new Date().toISOString(), type: 'step', stream: 'main', step: stepNumber, text, finishReason, usage: {inputTokens: stepUsage.inputTokens, outputTokens: usage?.outputTokens, cacheReadTokens: stepUsage.cacheReadTokens || undefined, cacheWriteTokens: stepUsage.cacheWriteTokens || undefined, noCacheTokens: stepUsage.noCacheTokens || undefined, reasoningTokens: stepUsage.reasoningTokens || undefined, cacheHitRatio: stepUsage.cacheHitRatio}});
        callbacks.debugLog(`step ${stepNumber} finished: ${finishReason}; text=${text.length}; toolCalls=${toolCalls.length}; toolResults=${toolResults.length}`);
      },
      onEnd(event) {
        const providerUsage = extractUsage({usage: event.usage});
        callbacks.recordTokenUsage?.({
          inputTokens: providerUsage.inputTokens,
          outputTokens: providerUsage.outputTokens,
          systemPrompt: inputBreakdown.systemPrompt,
          messages: inputBreakdown.messages,
          toolSchemas: inputBreakdown.toolSchemas,
          outputEstimate: estimateValueTokens(event.responseMessages),
          cacheReadTokens: providerUsage.cacheReadTokens,
          cacheWriteTokens: providerUsage.cacheWriteTokens,
          noCacheTokens: providerUsage.noCacheTokens,
          reasoningTokens: providerUsage.reasoningTokens,
          logicalInputEstimate: inputBreakdown.logicalInputEstimate,
          effectiveNonCachedInput: providerUsage.effectiveNonCachedInput,
        });
        const accumulated = [...stripSyntheticControls(requestMessages), ...event.responseMessages];
        const compacted = compactToolHistory(accumulated);
        callbacks.setConversation(compacted.messages);
        callbacks.debugLog(`conversation updated to ${compacted.messages.length} messages by ToolLoopAgent`);
      },
    });

    idleTimer.reset();
    const result = await agent.stream({messages: requestMessages, abortSignal: abortController.signal});

    for await (const part of result.stream) {
      idleTimer.reset();
      lastStreamEventAt = Date.now();
      lastStreamEventType = part.type;
      switch (part.type) {
        case 'text-delta': {
          callbacks.setBusyLabel?.(thinkingLabel);
          toolDisplay.startFreshToolGroup();
          const delta = sanitizeAssistantText(part.text);
          assistantText += delta;
          currentAssistantText += delta;
          const displayText = assistantDisplayText(currentAssistantText);
          if (!assistantStarted && !shouldStartAssistantStream(displayText, assistantStartedAt)) break;
          if (!assistantStarted) {
            assistantStarted = true;
            assistantStartedAt = Date.now();
            callbacks.onEvent?.(agentEvent({type: 'message_start', id: currentAssistantId, role: 'assistant'}));
            callbacks.addMessage({id: currentAssistantId, role: 'assistant', text: displayText, streaming: true, startedAt: assistantStartedAt});
          } else {
            callbacks.onEvent?.(agentEvent({type: 'message_update', id: currentAssistantId, text: displayText}));
            callbacks.updateMessage(currentAssistantId, {text: displayText});
          }
          break;
        }
        case 'tool-input-start': {
          if (currentAssistantText.trim().length > 0 || assistantStarted) {
            const pending = assistantDisplayText(currentAssistantText);
            const shown = finalizeAssistantSegment({beforeTool: true});
            if (!shown && pending) toolDisplay.setGroupCaption(pending);
          }
          const toolCall = {toolCallId: part.id, toolName: part.toolName, input: {}};
          latestToolCalls.set(part.id, toolCall);
          inFlightTools.add(part.id);
          callbacks.setBusyLabel?.(busyToolLabel(part.toolName, {}));
          toolDisplay.ensureToolItem(toolCall);
          break;
        }
        case 'tool-call': {
          if (currentAssistantText.trim().length > 0 || assistantStarted) {
            const pending = assistantDisplayText(currentAssistantText);
            const shown = finalizeAssistantSegment({beforeTool: true});
            if (!shown && pending) toolDisplay.setGroupCaption(pending);
          }
          const toolCall = {toolCallId: part.toolCallId, toolName: part.toolName, input: part.input};
          latestToolCalls.set(part.toolCallId, toolCall);
          // Tool execution begins only after its complete input has parsed and validated.
          startedTools.set(part.toolCallId, Date.now());
          callbacks.setBusyLabel?.(busyToolLabel(part.toolName, part.input));
          toolDisplay.ensureToolItem(toolCall).summary = toolCallSummary(part.toolName, part.input);
          toolDisplay.updateToolGroup(true);
          break;
        }
        case 'tool-result': {
          const toolCall = {toolCallId: part.toolCallId, toolName: part.toolName, input: part.input};
          latestToolCalls.set(part.toolCallId, toolCall);
          inFlightTools.delete(part.toolCallId);
          const startedAt = startedTools.get(part.toolCallId) ?? Date.now();
          // A budget-blocked call never reached the underlying implementation;
          // record it as a bounded non-event with no goal/observal side effect (RH-003).
          if (isToolBudgetBlocked(part.output)) {
            const item = toolDisplay.ensureToolItem(toolCall);
            item.status = 'error';
            item.result = 'skipped: tool-call budget exhausted';
            item.durationMs = Date.now() - startedAt;
            item.finishedAt = startedAt + (item.durationMs ?? 0);
            callbacks.onEvent?.(agentEvent({type: 'tool_end', id: toolCall.toolCallId, name: toolCall.toolName, success: false, errorCode: 'tool_budget_blocked', durationMs: item.durationMs ?? 0}));
            toolDisplay.updateToolGroup(true);
            break;
          }
          // A deadline-exceeded call was terminated at the wrapper boundary; the
          // underlying work may still be settling and must not mutate goal state (RH-004).
          if (isToolDeadlineExceeded(part.output)) {
            const item = toolDisplay.ensureToolItem(toolCall);
            item.status = 'error';
            item.result = `timed out after ${DEFAULT_TOOL_DEADLINE_MS}ms`;
            const durationMs = Date.now() - startedAt;
            item.durationMs = durationMs;
            item.finishedAt = startedAt + durationMs;
            callbacks.onEvent?.(agentEvent({type: 'tool_end', id: toolCall.toolCallId, name: toolCall.toolName, success: false, errorCode: 'tool_deadline', durationMs}));
            callbacks.onEvent?.(agentEvent({type: 'timeout', phase: 'tool', timeoutMs: toolCall.toolName === 'subagent' ? SUBAGENT_TOOL_DEADLINE_MS : DEFAULT_TOOL_DEADLINE_MS}));
            toolDisplay.updateToolGroup(true);
            break;
          }
          const ok = toolOutputOk(part.output, true);
          lastToolOk = ok;
          if (ok && part.toolName === unresolvedMalformedToolName) unresolvedMalformedToolName = undefined;
          const finish: NativeToolFinish = {toolCall, success: ok, output: part.output, durationMs: Date.now() - startedAt};
          const item = toolDisplay.ensureToolItem(toolCall);
          item.status = ok ? 'success' : 'error';
          item.result = toolResultSummary(finish);
          item.diff = toolDiffFromResult(toolCall, part.output);
          item.durationMs = finish.durationMs;
          item.finishedAt = startedAt + finish.durationMs;
          const failureDetails = ok || toolCategories.get(toolCall.toolName) !== 'builtin' ? {} : safeToolFailureDetails(part.output);
          callbacks.onEvent?.(agentEvent({type: 'tool_end', id: toolCall.toolCallId, name: toolCall.toolName, success: ok, output: part.output, ...failureDetails, durationMs: finish.durationMs}));
          logEntry(callbacks.log, {at: new Date().toISOString(), type: 'tool_result', stream: 'main', toolResult: {id: toolCall.toolCallId, name: toolCall.toolName, success: ok, output: part.output, durationMs: finish.durationMs}});
          observeGoalToolEvent(goal, {...toolCall, success: ok, output: part.output, duplicateSkipped: isDuplicateSkippedOutput(part.output)});
          callbacks.setWorkState?.(goal);
          callbacks.setGoalStatus?.(formatGoalStatus(goal));
          activeContextFiles = rememberContextFilesFromToolOutput(activeContextFiles, part.output);
          if (toolCall.toolName === 'writeTasks') callbacks.onTasksChanged?.();
          const nestedTokens = subagentTokenEstimate(part.output);
          if (nestedTokens) callbacks.recordTokenUsage?.({inputTokens: nestedTokens.input, outputTokens: nestedTokens.output, systemPrompt: 0, messages: 0, toolSchemas: 0, outputEstimate: 0, cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: nestedTokens.input, reasoningTokens: 0, logicalInputEstimate: nestedTokens.input, effectiveNonCachedInput: nestedTokens.input});
          toolDisplay.updateToolGroup(true);
          break;
        }
        case 'tool-error': {
          inFlightTools.delete(part.toolCallId);
          const existing = latestToolCalls.get(part.toolCallId);
          const toolCall = {toolCallId: part.toolCallId, toolName: part.toolName, input: part.input ?? existing?.input};
          const startedAt = startedTools.get(part.toolCallId) ?? Date.now();
          lastToolOk = false;
          if (isMalformedToolInputError(part.error)) {
            pendingMalformedToolName = part.toolName;
            unresolvedMalformedToolName = part.toolName;
          }
          const finish: NativeToolFinish = {toolCall, success: false, error: part.error, durationMs: Date.now() - startedAt};
          const item = toolDisplay.ensureToolItem(toolCall);
          item.status = 'error';
          item.result = toolResultSummary(finish);
          item.durationMs = finish.durationMs;
          item.finishedAt = startedAt + finish.durationMs;
          const publicError = toolCategories.get(toolCall.toolName) === 'builtin' ? {error: part.error} : {};
          callbacks.onEvent?.(agentEvent({type: 'tool_end', id: toolCall.toolCallId, name: toolCall.toolName, success: false, errorCode: 'tool_execution_error', ...publicError, durationMs: finish.durationMs}));
          logEntry(callbacks.log, {at: new Date().toISOString(), type: 'tool_result', stream: 'main', toolResult: {id: toolCall.toolCallId, name: toolCall.toolName, success: false, error: part.error, durationMs: finish.durationMs}});
          observeGoalToolEvent(goal, {...toolCall, success: false, output: part.error});
          callbacks.setWorkState?.(goal);
          callbacks.setGoalStatus?.(formatGoalStatus(goal));
          toolDisplay.updateToolGroup(true);
          break;
        }
        case 'error':
          streamError = part.error;
          callbacks.debugLog(`stream error: ${part.error instanceof Error ? part.error.message : String(part.error)}`);
          break;
        case 'finish':
          streamFinished = true;
          finishReason = part.finishReason;
          callbacks.debugLog(`ToolLoopAgent finished: ${part.finishReason}`);
          break;
        default:
          break;
      }
    }

    if (streamError && !streamFinished) {
      void Promise.resolve(result.responseMessages).catch(() => undefined);
      throw streamError;
    }

    try {
      const responseMessages = await result.responseMessages;
      const completedConversation = [...stripSyntheticControls(requestMessages), ...responseMessages];
      callbacks.setConversation(compactToolHistory(completedConversation).messages);
    } catch (error) {
      if (latestAccumulatedResponseMessages.length > 0) {
        callbacks.setConversation(compactToolHistory([...stripSyntheticControls(requestMessages), ...latestAccumulatedResponseMessages]).messages);
      }
      const text = error instanceof Error ? error.message : String(error);
      const benignTerminatedAfterStream = text === 'terminated' && (streamFinished || assistantText.trim().length > 0 || latestToolCalls.size > 0);
      if (!benignTerminatedAfterStream) throw streamError ?? error;
      callbacks.debugLog(`ignored post-stream response error: ${text}`);
    }

    if (currentAssistantText.trim().length > 0 || assistantStarted) {
      finalizeAssistantSegment();
    } else if (latestToolCalls.size > 0) {
      callbacks.addMessage({role: 'system', text: 'Tool work ended without a substantive final answer.'});
    }

    turnState.finishCause = normalizeFinishReason(finishReason);
    // Observable work evidence (Increment 3 surfaces this additively; tracked
    // here so the turn-wide state is the single source of runtime evidence).
    turnState.validationOutcome = deriveValidationOutcome(goal);
    turnState.mutationCount = goal.mutationCount;
    turnState.validationKind = goal.validations.at(-1)?.kind ?? goal.carriedValidation?.kind;
    turnState.validationAfterMutation = goal.validationSeq > 0 && goal.validationSeq >= goal.mutationSeq;
    turnState.taskProgress = goal.taskProgress;
    turnState.budgetBoundary = isBudgetExhausted(turnState, turnBudget);
    const completionEvidence: CompletionEvidence = {sawToolCall: latestToolCalls.size > 0, assistantText, lastToolOk, unresolvedToolInputError: unresolvedMalformedToolName != null};
    const readiness = assessCompletionReadiness(turnState, completionEvidence);
    const classification: TerminalClassification = classifyTerminalOutcome(turnState, completionEvidence);
    turnStatus = terminalTurnStatus({aborted: false, assistantText, sawToolCall: latestToolCalls.size > 0, lastToolOk, finishReason, budgetReached: turnState.budgetBoundary, unresolvedToolInputError: unresolvedMalformedToolName != null, intent: turnState.intent, mutationCount: turnState.mutationCount, validationOutcome: turnState.validationOutcome, taskProgress: turnState.taskProgress});
    if (unresolvedMalformedToolName) callbacks.addMessage({role: 'system', text: `${unresolvedMalformedToolName} did not execute because its generated input remained invalid or truncated. The requested work is incomplete.`});
    goal.phase = 'done';
    // Goal status reflects completion readiness, not the shallow text status:
    // unfinished-but-recoverable work is waiting on continuation (supervisor or
    // the user), while tool/input failures are concrete blockers. Prose alone
    // can never turn pending work into 'complete'.
    goal.status = turnStatus === 'aborted' ? 'aborted'
      : turnStatus === 'complete' ? 'complete'
        : readiness === 'tool_failure' || readiness === 'unresolved_tool_input' ? 'blocked'
          : goalContinuationRecoverable(readiness) ? 'needs-user'
            : 'blocked';
    callbacks.setWorkState?.(goal);
    callbacks.setGoalStatus?.(undefined);

    // Bounded recovery + the goal-level invariant. Length/rescue credits are
    // single-use and only the main flow proposes them; goal continuation is
    // repeatable while measurable progress continues. The invariant: when the
    // attempt classified `recoverable-incomplete` and no same-turn recovery can
    // run (budget/deadline boundary, exhausted slice, no-progress guard), the
    // attempt returns an `incomplete-goal` checkpoint — never a silent failure,
    // and never `complete`. The goal supervisor turns checkpoints into fresh
    // physical turns; a bare runAgentTurn caller surfaces them as resume info.
    const goalId = turnOptions.goalContext?.goalId ?? goal.id;
    const goalCycle = turnOptions.goalContext?.cycle ?? 1;
    const checkpointResult = (): AgentAttemptResult => ({status: 'failed', resume: buildIncompleteGoalResume(value, goalId, goalCycle, turnState, readiness)});
    if (!abortController.signal.aborted) {
      const lengthDecision = decideLengthRecovery(turnState, turnBudget);
      if (lengthDecision.action === 'continue') {
        const clamped = clampSlice(lengthDecision.slice, {steps: remainingSteps(turnState.stepsUsed, turnBudget), toolCalls: remainingToolCalls(turnState.toolCallsUsed, turnBudget)});
        if (clamped.steps > 0) recovery = {kind: 'length', control: lengthContinuationPrompt(), slice: {maxSteps: clamped.steps, maxToolCalls: clamped.toolCalls}};
      } else {
        const goalDecision = decideGoalContinuation(turnState, completionEvidence, turnBudget);
        const rescueDecision = turnOptions.recoverySlice == null
          ? decideRescue(turnState, completionEvidence, turnBudget, rescueEligibleRequest(goal.intent))
          : undefined;
        const goalSlice = goalDecision.action === 'continue' && remainingTurnDeadlineMs() > 0
          ? clampSlice(goalDecision.slice, {steps: remainingSteps(turnState.stepsUsed, turnBudget), toolCalls: remainingToolCalls(turnState.toolCallsUsed, turnBudget)})
          : undefined;
        const rescueSlice = goalSlice && goalSlice.steps > 0 ? undefined : rescueDecision?.action === 'continue'
          ? clampSlice(rescueDecision.slice, {steps: remainingSteps(turnState.stepsUsed, turnBudget), toolCalls: remainingToolCalls(turnState.toolCallsUsed, turnBudget)})
          : undefined;
        if (goalSlice && goalSlice.steps > 0) {
          recovery = {kind: 'goal', control: goalContinuationPrompt(describeCompletionReadiness(readiness, turnState.taskProgress)), slice: {maxSteps: goalSlice.steps, maxToolCalls: goalSlice.toolCalls}};
        } else if (rescueSlice && rescueSlice.steps > 0) {
          recovery = {kind: 'rescue', control: completionRescuePrompt(), slice: {maxSteps: rescueSlice.steps, maxToolCalls: rescueSlice.toolCalls}};
        } else if (classification === 'recoverable-incomplete') {
          // Budget boundary (`tool-calls`), exhausted slice, deadline, or no-progress
          // guard: end the physical turn with a resumable checkpoint.
          callbacks.debugLog(`goal checkpoint: readiness=${readiness}; goalDecision=${goalDecision.reason}; rescueDecision=${rescueDecision?.reason ?? 'not proposed from a recovery slice'}`);
          return checkpointResult();
        }
      }
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      if (abortCause.kind === 'model-stream-idle') {
        // Transport stall, not a user cancel. Preserve completed work first: the
        // conversation is salvaged from the last fully completed step so an
        // automatic retry (or a user-triggered resume) continues from there
        // instead of re-running — possibly mutating — tool work.
        if (latestAccumulatedResponseMessages.length > 0) {
          callbacks.setConversation(compactToolHistory([...stripSyntheticControls(requestMessages), ...latestAccumulatedResponseMessages]).messages);
        }
        if (idleStallRetryEligible) {
          const delay = retryDelayMs(retryAttempt);
          callbacks.onEvent?.(agentEvent({type: 'retry', attempt: retryAttempt + 1, maxAttempts: MAX_MODEL_RETRIES, delayMs: delay, error: `model stream idle for ${formatSeconds(IDLE_TIMEOUT_MS)}`}));
          callbacks.addMessage({role: 'system', text: `Model stream stalled for ${formatIdleMinutes(IDLE_TIMEOUT_MS)}; retrying attempt ${retryAttempt + 1}/${MAX_MODEL_RETRIES} in ${formatSeconds(delay)}. Completed steps are preserved.`});
          turnStatus = 'failed';
          // freshController: this stall aborted the controller to kill the hung
          // stream; the retry needs a live signal.
          return {status: turnStatus, retry: {attempt: retryAttempt + 1, contextOverflowRecovered, delayMs: delay, freshController: true}};
        }
        // Bounded retries exhausted, or the stalled step emitted partial output.
        // Pause with the active goal preserved (work state is untouched by this
        // path) instead of discarding progress; the interactive UI offers a
        // one-key resume from TurnResult.resume.
        turnStatus = 'failed';
        const afterStep = turnState.stepsUsed > 0 ? ` after step ${turnState.stepsUsed}` : '';
        callbacks.addMessage({role: 'system', text: `Model stream stalled for ${formatIdleMinutes(IDLE_TIMEOUT_MS)}; unfinished task paused${afterStep}. Press R to retry, or send a follow-up message to continue.`});
        return {status: turnStatus, resume: {kind: 'model-stream-idle', request: value, retryAttempt}};
      }
      if (abortCause.kind === 'turn-deadline') {
        // Absolute turn budget exhausted — distinct from a user cancel: the turn
        // ran out of time, not patience. No retry by definition (the deadline is
        // the bound), but completed-step progress stays in the conversation.
        turnState.aborted = true;
        turnStatus = 'aborted';
        callbacks.debugLog('turn exceeded the absolute deadline');
        callbacks.addMessage({role: 'system', text: `Turn stopped: the ${formatIdleMinutes(abortCause.timeoutMs ?? DEFAULT_TURN_DEADLINE_MS)} turn budget elapsed before the model finished. Completed steps are preserved in the conversation; send a follow-up to continue.`});
      } else {
        turnState.aborted = true;
        turnStatus = 'aborted';
        callbacks.debugLog('request aborted');
        callbacks.addMessage({role: 'system', text: 'Thinking aborted. You can type again.'});
      }
    } else {
      const text = error instanceof Error ? error.message : String(error);
      callbacks.debugLog(`error: ${text}`);
      if (!contextOverflowRecovered && isContextOverflowError(error)) {
        const canCompact = typeof callbacks.compactConversation === 'function';
        const compacted = canCompact
          ? callbacks.compactConversation?.('Automatic recovery after provider context overflow. Preserve the active user request and concrete next steps.') ?? false
          : false;
        callbacks.onEvent?.(agentEvent({type: 'context_overflow', recovered: compacted, error: text}));
        if (compacted) {
          callbacks.addMessage({role: 'system', text: 'Context overflow detected; compacted older context and retrying the same request once.'});
          return {status: 'failed', retry: {attempt: retryAttempt, contextOverflowRecovered: true, delayMs: 0}};
        }
        callbacks.addMessage({role: 'system', text: canCompact
          ? 'Context overflow detected, but there was not enough conversation history to compact automatically.'
          : 'Context overflow detected, and this mode does not attempt automatic compaction. Resume the session interactively or retry with a smaller request.'});
      }
      // Transient model errors share the bounded retry pool with idle-stream
      // stalls, so a turn can never retry more than MAX_MODEL_RETRIES times total.
      if (retryAttempt < MAX_MODEL_RETRIES && isRetryableModelError(error)) {
        const delay = retryDelayMs(retryAttempt);
        callbacks.onEvent?.(agentEvent({type: 'retry', attempt: retryAttempt + 1, maxAttempts: MAX_MODEL_RETRIES, delayMs: delay, error: text}));
        callbacks.addMessage({role: 'system', text: `Transient model error; retrying attempt ${retryAttempt + 1}/${MAX_MODEL_RETRIES} in ${formatSeconds(delay)}: ${text}`});
        return {status: 'failed', retry: {attempt: retryAttempt + 1, contextOverflowRecovered, delayMs: delay}};
      }
      callbacks.addMessage({role: 'assistant', text: `Model call failed: ${text}`});
    }
  } finally {
    if (loadedMcp?.clients.length) await closeMcpClients(loadedMcp.clients);
    if (lspPool) await lspPool.close();
    idleTimer.clear();
    toolDisplay.stopToolTimer();
    toolDisplay.finalizeToolGroup();
  }
  return {status: turnStatus, recovery};
}

export async function runAgentTurn(
  value: string,
  displayValue: string | undefined,
  contextFiles: ContextFile[],
  callbacks: StreamCallbacks,
  retryAttempt = 0,
  retryingExistingRequest = false,
  contextOverflowRecovered = false,
  session?: PromptSession,
  modelOverride?: string,
  turnOptions: TurnExecutionOptions = {},
): Promise<TurnResult> {
  // The controller is replaced when an idle-stall retry needs a live signal
  // after aborting a hung stream, so both it and the cause are mutable.
  let abortController = new AbortController();
  let abortCause = createUserAbortCause();
  let status: TurnStatus = 'failed';
  let resume: TurnResult['resume'];
  const turnState = createTurnExecutionState();
  callbacks.onEvent?.(agentEvent({type: 'turn_start', request: value}));
  callbacks.setBusy(true);
  callbacks.setAbortController?.(abortController);
  if (!retryingExistingRequest) callbacks.addMessage({role: 'user', text: displayValue ?? value});
  let turnDeadline: AbsoluteDeadline | undefined;
  const turnStartedAt = Date.now();
  const turnDeadlineMs = turnOptions.turnDeadlineMs ?? DEFAULT_TURN_DEADLINE_MS;
  try {
    // Retries are one logical turn and therefore share coordinator admission and
    // the workspace mutation lease, including quarantined lingering work. A
    // goal supervisor may pass one shared scope so every physical turn of the
    // logical goal shares the same lease.
    const turnScope: {executionScope?: TurnExecutionScope} = turnOptions.sharedTurnScope ?? {};
    const turnBudget = mainTurnBudget();
    // Turn-wide execution budget (RH-003): one authoritative counter of
    // underlying tool executions, shared across retries and recovery slices so
    // the global limit cannot be reset or exceeded.
    const globalBudget = createToolExecutionBudget();
    // Turn-wide work state: persists across provider retries and recovery
    // slices so mutation/validation evidence accumulates correctly. When the
    // goal supervisor continues a logical goal, cumulative evidence (tasks,
    // mutations, carried validation) is hydrated so a fresh physical turn
    // cannot complete while carried work remains.
    const goal = createSessionGoal(value);
    if (turnOptions.goalContext) seedCarriedGoalEvidence(goal, turnOptions.goalContext.carried);
    // Completion policy is intent-sensitive (implement/fix/test expect
    // post-mutation validation); the turn-wide state carries the classified intent.
    turnState.intent = goal.intent;
    let activeOptions = turnOptions;
    let attempt = retryAttempt;
    let overflowRecovered = contextOverflowRecovered;
    let retrying = retryingExistingRequest;
    while (true) {
      // Absolute main-turn deadline (RH-004): distinct from the idle timer, it
      // bounds total turn elapsed time so a stream of busy tools cannot defer
      // it. Recreated per attempt with the remaining wall-clock budget and bound
      // to the current attempt's controller — an idle-stall retry replaces the
      // controller and must not trip this deadline early via the old signal.
      turnDeadline = createAbsoluteDeadline({
        timeoutMs: Math.max(0, turnDeadlineMs - (Date.now() - turnStartedAt)),
        signal: abortController.signal,
        onTimeout: () => {
          if (abortController.signal.aborted) return;
          callbacks.onEvent?.(agentEvent({type: 'timeout', phase: 'turn', timeoutMs: turnDeadlineMs}));
          abortForTurn(abortCause, {kind: 'turn-deadline', timeoutMs: turnDeadlineMs}, abortController, `haze turn exceeded the ${turnDeadlineMs}ms absolute deadline.`);
        },
      });
      const result = await runAgentAttempt(value, contextFiles, callbacks, attempt, retrying, overflowRecovered, session, modelOverride, abortController, activeOptions, turnScope, turnState, turnBudget, globalBudget, goal, abortCause, () => Math.max(0, turnDeadlineMs - (Date.now() - turnStartedAt)));
      turnDeadline.clear();
      turnDeadline = undefined;
      status = result.status;
      resume = result.resume;
      if (result.retry) {
        attempt = result.retry.attempt;
        overflowRecovered = result.retry.contextOverflowRecovered;
        retrying = true;
        if (result.retry.freshController) {
          // The idle stall aborted the previous controller to kill the hung
          // stream; the retry needs a live one (and a fresh 'user' cause).
          abortController = new AbortController();
          abortCause = createUserAbortCause();
          callbacks.setAbortController?.(abortController);
        }
        if (result.retry.delayMs > 0) await abortableDelay(result.retry.delayMs, abortController.signal);
        if (abortController.signal.aborted) { status = 'aborted'; break; }
        continue;
      }
      // Bounded recovery slice (length-continuation, rescue, or goal
      // continuation). Length/rescue credits are single-use, so a slice cannot
      // trigger another of the same kind; goal continuation is repeatable but
      // progress-guarded and counts against the shared turn budget. Abort is
      // re-checked before and within the slice.
      if (result.recovery && !abortController.signal.aborted) {
        const rec = result.recovery;
        if (rec.kind === 'length') { turnState.lengthCreditUsed = true; turnState.lengthRecoveriesAttempted += 1; } else if (rec.kind === 'rescue') turnState.rescueUsed = true; else recordGoalContinuation(turnState);
        activeOptions = {...activeOptions, ephemeralControl: rec.control, recoverySlice: {kind: rec.kind, maxSteps: rec.slice.maxSteps, maxToolCalls: rec.slice.maxToolCalls}};
        retrying = true;
        callbacks.debugLog(`starting ${rec.kind} recovery slice: ${rec.slice.maxSteps} steps / ${rec.slice.maxToolCalls} tool calls`);
        continue;
      }
      break;
    }
    const evidence = toCompletionEvidence(turnState);
    return {status, evidence, ...(resume ? {resume} : {})};
  } finally {
    turnDeadline?.clear();
    callbacks.onEvent?.(agentEvent({type: 'turn_end', request: value, status, evidence: toCompletionEvidence(turnState)}));
    callbacks.setAbortController?.(null);
    callbacks.setBusyLabel?.(modelThinkingLabel(undefined));
    callbacks.setBusy(false);
  }
}
