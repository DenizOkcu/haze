import type {ModelMessage, ToolSet} from 'ai';
import type {ContextFile} from '../../../config/contextFiles.js';
import {readSettings} from '../../../config/settings.js';
import {agentEvent} from '../../../core/agent/events.js';
import {isPlanOnlyRequest} from '../../../core/agent/goalPolicy.js';
import {formatGoalStatus, type SessionGoal} from '../../../core/agent/goalPolicy.js';
import {calculateRequestTokenBudget, estimateMessagesTokens} from '../../../core/agent/contextBudget.js';
import {compactToolHistory, stripSyntheticControls, withSyntheticControl, withoutSystemMessages} from '../../../core/agent/requestAssembly.js';
import {compactModelMessages} from '../../../core/agent/compaction.js';
import {DEFAULT_MAX_OUTPUT_TOKENS, MAIN_STEP_LIMIT, MAIN_TOOL_CALL_LIMIT, SUBAGENT_TOOL_DEADLINE_MS, DEFAULT_TOOL_DEADLINE_MS, withToolExecutionBudget, type ToolExecutionBudgetState, type TurnBudget} from '../../../core/agent/budgets.js';
import {withToolDeadline} from '../../../core/deadline.js';
import {isMutatingCapability, isValidationCapable} from '../../../core/agent/toolCapabilities.js';
import {userTurnMessage} from '../../../core/attachments/imageAttachments.js';
import {WorkspaceMutationPolicy} from '../../../core/subagent/workspaceMutationPolicy.js';
import {modelWithConfig, providerRequestSettings, type ModelRuntimeSelection} from '../../../llm/client.js';
import {assembleRequestContext, type ToolCategory, type TurnExecutionScope} from '../../../llm/requestContext.js';
import type {LoadedMcpTools} from '../../../llm/mcp.js';
import type {LspPool} from '../../../llm/lsp/pool.js';
import type {PromptSession} from '../../../llm/systemPrompt.js';
import type {HazeToolContext} from '../../../llm/tools/toolContext.js';
import {modelThinkingLabel} from '../../../utils/modelName.js';
import type {StreamCallbacks, TurnExecutionOptions} from '../streaming.js';
import {estimateInputBreakdown, logEntry} from './turnRuntime.js';

/**
 * Restrict a tool set to the capabilities permitted in a completion-rescue
 * slice: mutation (edit/write/replace) and validation-capable (shell) built-in
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

/** What `prepareAttempt` produced for the rest of the attempt (loop, outcome, cleanup). */
export interface AttemptSetup {
  /** Resolved provider model handle and effective config for this attempt. */
  runtime: ModelRuntimeSelection;
  thinkingLabel: string;
  systemPrompt: string;
  /** Durable request messages (synthetic control already applied). */
  requestMessages: ModelMessage[];
  requestBudget: ReturnType<typeof calculateRequestTokenBudget>;
  inputBreakdown: ReturnType<typeof estimateInputBreakdown>;
  providerSettings: Omit<ReturnType<typeof providerRequestSettings>, 'omitMaxOutputTokens'>;
  omitMaxOutputTokens: boolean | undefined;
  /** Tools visible to this attempt: rescue-restricted, budget-clamped, and deadline-wrapped. */
  sliceTools: ToolSet;
  stepCap: number;
  /** A rescue slice with no qualifying tools must synthesize, never reopen discovery (F-08). */
  rescueWithoutTools: boolean;
  toolExecutionContext: HazeToolContext;
  likelyPlanOnlyRequest: boolean;
  loadedMcp: LoadedMcpTools | undefined;
  lspPool: LspPool | undefined;
  contextFiles: ContextFile[];
  /** Tool category map from request assembly (builtin/lsp/subagent/skill/mcp). */
  toolCategories: Map<string, ToolCategory>;
}

export interface AttemptSetupDeps {
  value: string;
  contextFiles: ContextFile[];
  callbacks: StreamCallbacks;
  retryingExistingRequest: boolean;
  contextOverflowRecovered: boolean;
  session: PromptSession | undefined;
  modelOverride: string | undefined;
  abortController: AbortController;
  turnOptions: TurnExecutionOptions;
  turnScope: {executionScope?: TurnExecutionScope};
  turnBudget: TurnBudget;
  globalBudget: ToolExecutionBudgetState;
  /** Shared slice execution state (see AgentAttemptInput.sliceBudget). */
  sliceBudget: ToolExecutionBudgetState;
  goal: SessionGoal;
  onContextFileRead: (path: string) => void;
}

/**
 * Assemble one attempt: resolve the model (single fresh settings read, CR-024),
 * build the request context, clamp the request to the model-aware token budget,
 * and wrap the slice's tools with the execution-boundary budget (RH-003) and
 * per-tool deadlines (RH-004). Returns `undefined` when no provider is
 * configured (the caller-reported failure path).
 */
export async function prepareAttempt(deps: AttemptSetupDeps): Promise<AttemptSetup | undefined> {
  const {value, contextFiles, callbacks, retryingExistingRequest, contextOverflowRecovered, session, modelOverride, abortController, turnOptions, turnScope, turnBudget, goal, globalBudget, sliceBudget, onContextFileRead} = deps;
  // Single choke point: one fresh settings read per turn, shared by model
  // resolution and request assembly (CR-024).
  const turnSettings = await readSettings();
  const runtime = await modelWithConfig({cwd: session?.cwd, modelSelector: modelOverride}, turnSettings);
  if (!runtime?.model) {
    callbacks.addMessage({role: 'assistant', text: 'No model provider configured. Run /provider to choose or add a provider. haze cannot hallucinate without a model. Progress.'});
    return undefined;
  }

  const thinkingLabel = modelThinkingLabel(runtime.config.modelName);
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

  const activeContextFiles = contextFiles;
  const activeModel = runtime.model;
  const {omitMaxOutputTokens, ...providerSettings} = providerRequestSettings(runtime.config);
  const assembled = await assembleRequestContext({request: value, contextFiles: activeContextFiles, session, model: activeModel, modelRuntime: runtime, subagentOverrides: turnOptions.subagentOverrides, abortSignal: abortController.signal, executionScope: turnScope.executionScope, settings: turnSettings, onSubagentEvent: event => callbacks.onEvent?.(agentEvent(event.type === 'queued'
    ? {type: 'subagent_state', id: event.id, state: 'queued', mode: event.mode, queued: event.queued, running: event.running}
    : event.type === 'started'
      ? {type: 'subagent_state', id: event.id, state: 'started', mode: event.mode, queueMs: event.queueMs, running: event.running}
      : event.type === 'terminal'
        ? {type: 'subagent_state', id: event.id, state: 'terminal', mode: event.mode, queueMs: event.queueMs, durationMs: event.durationMs, termination: event.termination, execution: event.execution, running: event.running}
        : {type: 'subagent_state', id: event.id, state: 'settled', mode: event.mode, queueMs: event.queueMs, durationMs: event.durationMs, termination: event.termination, execution: 'settled', running: event.running}))});
  turnScope.executionScope ??= assembled.executionScope;
  const availableTools = assembled.availableTools;
  const toolCategories = assembled.toolCategories;
  const loadedMcp = assembled.loadedMcp;
  const lspPool = assembled.lspPool;
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
  let requestMessages = durableRequestMessages;
  if (estimateMessagesTokens(requestMessages) > overflowTargetTokens) {
    requestMessages = compactModelMessages(requestMessages, {tokenBudget: overflowTargetTokens, workState: goal}).messages;
  }
  requestMessages = withoutSystemMessages(requestMessages);
  callbacks.setConversation(stripSyntheticControls(requestMessages));
  if (turnOptions.ephemeralControl) requestMessages = withSyntheticControl(requestMessages, turnOptions.ephemeralControl);

  const systemPrompt = assembled.systemPrompt;
  const inputBreakdown = estimateInputBreakdown({system: systemPrompt, contextFiles: activeContextFiles, messages: requestMessages, tools: availableTools});
  logEntry(callbacks.log, {at: new Date().toISOString(), type: 'request', stream: 'main', system: systemPrompt, messages: requestMessages, tools: Object.keys(availableTools), context: inputBreakdown.breakdown});

  const contextFileSignatures = callbacks.contextFileSignatures ?? new Map(activeContextFiles.flatMap(file => file.signature ? [[file.path, file.signature] as const] : []));
  const mutationPolicy = assembled.executionScope?.mutationPolicy ?? new WorkspaceMutationPolicy();
  const toolExecutionContext: HazeToolContext = {inFlightToolCalls: new Map<string, Promise<unknown>>(), loadedContextFilePaths: new Set(activeContextFiles.map(file => file.path)), loadedContextFileSignatures: contextFileSignatures, onContextFileRead, mutationPolicy, blessedPaths: turnOptions.blessedPaths};

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
  // (shared across retries and recovery slices); the slice budget belongs to
  // the current slice (main phase or one recovery slice) and is provided by
  // the turn loop so provider retries within the slice cannot re-arm its cap
  // (round-1 C2): the slice envelope is clamped once at slice admission. Both
  // are checked atomically at the actual execute boundary so one oversized
  // parallel batch cannot overshoot.
  const sliceToolCallCap = turnOptions.recoverySlice?.maxToolCalls ?? MAIN_TOOL_CALL_LIMIT;
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

  return {
    runtime,
    thinkingLabel,
    systemPrompt,
    requestMessages,
    requestBudget,
    inputBreakdown,
    providerSettings,
    omitMaxOutputTokens,
    sliceTools: deadlineWrappedTools,
    stepCap,
    rescueWithoutTools,
    toolExecutionContext,
    likelyPlanOnlyRequest,
    loadedMcp,
    lspPool,
    contextFiles: activeContextFiles,
    toolCategories,
  };
}
