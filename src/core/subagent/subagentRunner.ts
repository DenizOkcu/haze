import {generateText, isStepCount, tool, type JSONValue, type ModelMessage, type ToolSet} from 'ai';
import type {ContextFile} from '../../config/contextFiles.js';
import {estimateToolSchemas, estimateValueTokens} from '../agent/contextBudget.js';
import {
  SUBAGENT_MAX_STEPS,
  SUBAGENT_MIN_STEPS,
  SUBAGENT_SYNTHESIS_RESERVE,
  SUBAGENT_TOOL_ONLY_LIMIT,
} from '../agent/budgets.js';
import {storeToolOutput} from '../agent/toolOutputStore.js';
import {withSyntheticControl} from '../agent/requestAssembly.js';
import {toolOnlyStepCount} from '../agent/turnPolicy.js';
import {assembleWorkerContext, workerTaskMessage, type WorkerContextBundle} from '../../llm/workerContext.js';
import type {PromptSession} from '../../llm/systemPrompt.js';
import {buildSubagentPrompt, projectContextSection} from '../../llm/systemPrompt.js';
import {hazeTools} from '../../llm/hazeTools.js';
import {toolsContextFor, type HazeToolContext} from '../../llm/tools/toolContext.js';
import {
  fallbackWorkerRuntime,
  normalizeSubagentInput,
  subagentInputSchema,
  withLegacyProjection,
  type SubagentExecutionResult,
  type SubagentResultCapsule,
  type SubagentTaskCapsule,
  type SubagentTelemetry,
  type SubagentToolInput,
  type WorkerRuntime,
  type WorkerTermination,
} from './contracts.js';
import {COMPATIBILITY_PROFILE, MODE_TOOL_NAMES, type SubagentExecutionProfile} from './executionProfiles.js';
import {SubagentCoordinator} from './subagentCoordinator.js';
import {WorkspaceMutationPolicy} from './workspaceMutationPolicy.js';
import {resolveWorkspacePath, workspaceRelativePath} from '../../utils/path.js';

const SYNTHESIS_DIRECTIVE = 'You have reached your tool/step budget. Stop calling tools. Return the requested self-contained deliverable now, including evidence, coverage gaps, changed paths, validation, and precise remaining work. A concise partial deliverable is mandatory and better than an empty response.';

type SubagentStep = {toolCalls: unknown[]; text: string};

const TOOL_BUDGET_BLOCKED = '__hazeSubagentToolBudgetBlocked';

function withToolExecutionBudget(tools: ToolSet, maxToolCalls: number, state: {started: number; exceeded: boolean}): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([name, definition]) => {
    if (typeof definition.execute !== 'function') return [name, definition];
    const execute = definition.execute as unknown as (...args: unknown[]) => unknown;
    return [name, {
      ...definition,
      execute: (...args: unknown[]) => {
        // This check is at the actual execute boundary. Concurrent calls from
        // one emitted batch enter synchronously, so no more than the remaining
        // budget can reach an underlying tool implementation.
        if (state.started >= maxToolCalls) {
          state.exceeded = true;
          return {ok: false, [TOOL_BUDGET_BLOCKED]: true, error: `Subagent tool-call budget of ${maxToolCalls} exhausted; execution was blocked.`};
        }
        state.started++;
        return execute(...args);
      },
    }];
  })) as ToolSet;
}

function toolSummary(output: unknown): string {
  if (typeof output !== 'object' || output == null) return 'completed';
  const value = output as Record<string, unknown>;
  if (typeof value.totalMatches === 'number') return value.totalMatches === 0 ? 'no matches' : `${value.matchCountIsLowerBound === true ? 'at least ' : ''}${value.totalMatches} matches`;
  if (typeof value.code === 'number') return `exit ${value.code}`;
  if (value.ok === true) return 'completed';
  if (value.ok === false && typeof value.error === 'string') return `failed: ${value.error.slice(0, 120)}`;
  return 'completed';
}

function shouldForceSynthesis(steps: SubagentStep[], maxSteps: number, maxToolCalls = COMPATIBILITY_PROFILE.maxToolCalls): boolean {
  return toolOnlyStepCount(steps) >= SUBAGENT_TOOL_ONLY_LIMIT
    || steps.flatMap(step => step.toolCalls).length >= maxToolCalls
    || steps.length >= maxSteps - SUBAGENT_SYNTHESIS_RESERVE;
}

function pendingScopedControl(messages: ModelMessage[], context: HazeToolContext) {
  const files = context.pendingContextFiles ?? [];
  if (files.length === 0) return messages;
  context.pendingContextFiles = [];
  return withSyntheticControl(messages, `Additional scoped project instructions now apply. Follow them before subsequent work.${projectContextSection(files)}`);
}

function changedPathFromOutput(name: string, output: unknown) {
  if (!['editFile', 'replaceLines', 'writeFile'].includes(name) || typeof output !== 'object' || output == null) return undefined;
  const value = output as {ok?: unknown; path?: unknown};
  if (value.ok !== true || typeof value.path !== 'string') return undefined;
  try { return workspaceRelativePath(resolveWorkspacePath(value.path)); } catch { return undefined; }
}

function validationFromOutput(name: string, output: unknown) {
  if (name !== 'bash' || typeof output !== 'object' || output == null) return undefined;
  const value = output as {command?: unknown; ok?: unknown; validationSummary?: unknown};
  if (typeof value.command !== 'string' || typeof value.validationSummary !== 'object' || value.validationSummary == null) return undefined;
  return {command: value.command, ok: value.ok === true};
}

function telemetryBase(runtime: WorkerRuntime, profile: SubagentExecutionProfile, taskTokens: number, initialInputTokens: number, queueMs = 0): SubagentTelemetry {
  return {modelSelector: runtime.selector, profile: profile.name, durationMs: 0, queueMs, toolCallCount: 0, toolCalls: [], usage: {}, estimates: {taskCapsuleTokens: taskTokens, initialInputTokens, privateContextTokens: 0, resultCapsuleTokens: 0, mainContextTokensAvoided: 0}};
}

function terminalResult(task: SubagentTaskCapsule, runtime: WorkerRuntime, profile: SubagentExecutionProfile, termination: WorkerTermination, message: string, queueMs = 0): SubagentExecutionResult {
  const capsule: SubagentResultCapsule = {id: task.id, termination, usable: false, deliverable: message, changedPaths: [], validation: [], coverageGaps: [message], truncated: false};
  const telemetry = telemetryBase(runtime, profile, estimateValueTokens(workerTaskMessage(task)), 0, queueMs);
  telemetry.estimates.resultCapsuleTokens = estimateValueTokens(capsule);
  return withLegacyProjection(capsule, telemetry, termination === 'provider_error' || termination === 'policy_blocked' ? message : undefined);
}

export type SubagentResult = SubagentExecutionResult;

export async function runSubagent(
  taskInput: string | SubagentTaskCapsule,
  options: {
    model?: WorkerRuntime['model'];
    runtime?: WorkerRuntime;
    profile?: SubagentExecutionProfile;
    contextFiles?: ContextFile[];
    contextBundle?: WorkerContextBundle;
    allowedTools?: readonly string[];
    maxSteps?: number;
    abortSignal?: AbortSignal;
    deadlineExpired?: () => boolean;
    queueMs?: number;
    session?: PromptSession;
    mutationPolicy?: WorkspaceMutationPolicy;
  },
): Promise<SubagentExecutionResult> {
  const profile = options.profile ?? COMPATIBILITY_PROFILE;
  const runtime: WorkerRuntime = options.runtime ?? fallbackWorkerRuntime(options.model!);
  const task: SubagentTaskCapsule = typeof taskInput === 'string'
    ? {id: 'worker', objective: taskInput, deliverable: 'Return a concise self-contained result.', mode: options.allowedTools ? (options.allowedTools.some(name => ['editFile', 'replaceLines', 'writeFile'].includes(name)) ? 'implement' : options.allowedTools.includes('bash') ? 'validate' : options.allowedTools.includes('fetch') ? 'research' : 'inspect') : 'implement', scope: [], acceptanceCriteria: [], legacyMaxSteps: options.maxSteps}
    : taskInput;
  const requestedSteps = task.legacyMaxSteps ?? options.maxSteps;
  if (requestedSteps != null && (requestedSteps < SUBAGENT_MIN_STEPS || requestedSteps > SUBAGENT_MAX_STEPS)) return terminalResult(task, runtime, profile, 'policy_blocked', `maxSteps must be from ${SUBAGENT_MIN_STEPS} to ${SUBAGENT_MAX_STEPS}.`);
  const maxSteps = Math.min(requestedSteps ?? profile.maxSteps, profile.maxSteps);
  const startedAt = performance.now();
  const bundle = options.contextBundle ?? (options.contextFiles
    ? await compatibilityBundle(task, profile, options.contextFiles, options.allowedTools, options.session)
    : await assembleWorkerContext(task, profile, options.session));
  if (bundle.policyBlock) return terminalResult(task, runtime, profile, 'policy_blocked', bundle.policyBlock, options.queueMs);

  const toolCallLog: SubagentTelemetry['toolCalls'] = [];
  const changedPaths = new Set<string>();
  const validation: SubagentResultCapsule['validation'] = [];
  let usageIn: number | undefined;
  let usageOut: number | undefined;
  const toolBudget = {started: 0, exceeded: false};
  const budgetedTools = withToolExecutionBudget(bundle.tools, profile.maxToolCalls, toolBudget);
  const mutationPolicy = options.mutationPolicy;
  const mutationOwner = mutationPolicy?.createOwner();
  const toolExecutionContext: HazeToolContext = {
    isSubagent: true,
    inFlightToolCalls: new Map(), loadedContextFilePaths: new Set(bundle.loadedPaths),
    loadedContextFileSignatures: new Map(bundle.loadedSignatures),
    ...(mutationPolicy && mutationOwner ? {mutationPolicy, mutationOwner} : {}),
  };
  const release = mutationPolicy && mutationOwner && (task.mode === 'implement' || task.mode === 'validate')
    ? await mutationPolicy.acquire(mutationOwner, options.abortSignal).catch(() => undefined)
    : undefined;
  if (mutationPolicy && mutationOwner && (task.mode === 'implement' || task.mode === 'validate') && !release) return terminalResult(task, runtime, profile, options.deadlineExpired?.() ? 'deadline_exceeded' : 'cancelled', 'Worker cancelled before workspace admission.', options.queueMs);

  try {
    const {omitMaxOutputTokens, ...providerRequestOptions} = runtime.requestOptions;
    const result = await generateText({
      model: runtime.model,
      instructions: bundle.systemPrompt,
      messages: [{role: 'user', content: workerTaskMessage(task)}],
      tools: budgetedTools,
      stopWhen: isStepCount(maxSteps),
      ...(!omitMaxOutputTokens ? {maxOutputTokens: profile.maxOutputTokens} : {}),
      maxRetries: profile.maxRetries,
      ...providerRequestOptions,
      abortSignal: options.abortSignal,
      runtimeContext: toolExecutionContext,
      toolsContext: toolsContextFor(budgetedTools, toolExecutionContext) as never,
      prepareStep({steps, messages}) {
        const scopedMessages = pendingScopedControl(messages, toolExecutionContext);
        if (!toolBudget.exceeded && toolBudget.started < profile.maxToolCalls && !shouldForceSynthesis(steps, maxSteps, profile.maxToolCalls)) return scopedMessages !== messages ? {messages: scopedMessages} : undefined;
        return {toolChoice: 'none' as const, messages: withSyntheticControl(scopedMessages, SYNTHESIS_DIRECTIVE)};
      },
      onStepEnd({usage}) {
        if (typeof usage?.inputTokens === 'number') usageIn = (usageIn ?? 0) + usage.inputTokens;
        if (typeof usage?.outputTokens === 'number') usageOut = (usageOut ?? 0) + usage.outputTokens;
      },
      onToolExecutionEnd(event) {
        if (!event.toolCall) return;
        const output = event.toolOutput.type === 'tool-result' ? event.toolOutput.output : undefined;
        if (typeof output === 'object' && output != null && TOOL_BUDGET_BLOCKED in output) return;
        const toolError = 'error' in event.toolOutput ? event.toolOutput.error : 'tool execution failed';
        if (toolCallLog.length < profile.maxToolCalls) toolCallLog.push({name: event.toolCall.toolName, summary: output === undefined ? `failed: ${String(toolError).slice(0, 120)}` : toolSummary(output), durationMs: event.toolExecutionMs});
        const changedPath = changedPathFromOutput(event.toolCall.toolName, output);
        if (changedPath) changedPaths.add(changedPath);
        const validationRecord = validationFromOutput(event.toolCall.toolName, output);
        if (validationRecord) validation.push(validationRecord);
      },
    });
    usageIn = result.usage.inputTokens ?? usageIn;
    usageOut = result.usage.outputTokens ?? usageOut;
    const fullText = result.text.trim();
    const truncated = fullText.length > profile.maxSummaryChars;
    const resultHandle = truncated ? storeToolOutput(fullText) : undefined;
    const deliverable = fullText
      ? `${fullText.slice(0, profile.maxSummaryChars)}${truncated ? '\n\n[Result truncated; retrieve the non-durable resultHandle only if needed.]' : ''}`
      : 'Subagent completed without text output.';
    const totalToolCalls = toolBudget.started;
    const toolLimited = toolBudget.exceeded || totalToolCalls >= profile.maxToolCalls;
    const termination: WorkerTermination = options.deadlineExpired?.() ? 'deadline_exceeded'
      : options.abortSignal?.aborted ? 'cancelled'
        : toolLimited ? 'tool_limit'
          : result.steps.length >= maxSteps && !fullText ? 'step_limit'
            : !fullText ? 'no_output'
              : 'completed';
    const capsule: SubagentResultCapsule = {id: task.id, termination, usable: fullText.length > 0, deliverable, changedPaths: [...changedPaths].sort(), validation, coverageGaps: [], truncated, ...(resultHandle ? {resultHandle} : {})};
    const durationMs = performance.now() - startedAt;
    const telemetry = telemetryBase(runtime, profile, bundle.taskTokens, bundle.estimatedTokens, options.queueMs);
    telemetry.durationMs = durationMs;
    telemetry.toolCallCount = totalToolCalls;
    telemetry.toolCalls = toolCallLog;
    telemetry.usage = {inputTokens: usageIn, outputTokens: usageOut};
    telemetry.estimates.privateContextTokens = (usageIn ?? bundle.estimatedTokens) + (usageOut ?? 0);
    telemetry.estimates.resultCapsuleTokens = estimateValueTokens(capsule);
    telemetry.estimates.mainContextTokensAvoided = Math.max(0, telemetry.estimates.privateContextTokens - telemetry.estimates.taskCapsuleTokens - telemetry.estimates.resultCapsuleTokens);
    return withLegacyProjection(capsule, telemetry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const termination: WorkerTermination = options.deadlineExpired?.() ? 'deadline_exceeded' : options.abortSignal?.aborted ? 'cancelled' : 'provider_error';
    const result = terminalResult(task, runtime, profile, termination, message, options.queueMs);
    result.telemetry.durationMs = performance.now() - startedAt;
    result.durationMs = result.telemetry.durationMs;
    result.telemetry.toolCalls = toolCallLog;
    result.toolCalls = toolCallLog;
    result.telemetry.toolCallCount = toolBudget.started;
    result.toolCallCount = toolBudget.started;
    result.telemetry.usage = {inputTokens: usageIn, outputTokens: usageOut};
    result.tokens = {in: usageIn, out: usageOut};
    return result;
  } finally {
    release?.();
  }
}

async function compatibilityBundle(task: SubagentTaskCapsule, profile: SubagentExecutionProfile, contextFiles: ContextFile[], allowedTools?: readonly string[], session?: PromptSession): Promise<WorkerContextBundle> {
  const instructions = contextFiles;
  const systemPrompt = buildSubagentPrompt(instructions, session, task.mode, profile);
  const tools: ToolSet = {};
  for (const name of allowedTools ?? MODE_TOOL_NAMES[task.mode]) if (name in hazeTools) tools[name] = hazeTools[name as keyof typeof hazeTools];
  const taskTokens = estimateValueTokens(workerTaskMessage(task));
  const estimatedTokens = estimateValueTokens(systemPrompt) + taskTokens + estimateToolSchemas(tools).reduce((sum, value) => sum + value.tokens, 0);
  return {instructions, systemPrompt, tools, taskTokens, estimatedTokens, validatedScope: [], loadedPaths: new Set(instructions.map(file => file.path)), loadedSignatures: new Map(instructions.flatMap(file => file.signature ? [[file.path, file.signature] as const] : [])), ...(estimatedTokens > profile.maxInputTokens ? {policyBlock: `Worker input estimate ${estimatedTokens} exceeds profile ${profile.name} limit ${profile.maxInputTokens}.`} : {})};
}

export function createSubagentTool(options: {
  model?: WorkerRuntime['model'];
  runtime?: WorkerRuntime;
  profile?: SubagentExecutionProfile;
  coordinator?: SubagentCoordinator;
  mutationPolicy?: WorkspaceMutationPolicy;
  blockedReason?: string;
  forceMode?: 'inspect';
  contextFiles?: ContextFile[];
  session?: PromptSession;
}) {
  const profile = options.profile ?? COMPATIBILITY_PROFILE;
  const runtime: WorkerRuntime = options.runtime ?? fallbackWorkerRuntime(options.model!);
  const coordinator = options.coordinator ?? new SubagentCoordinator(profile);
  return tool<SubagentToolInput, SubagentExecutionResult, HazeToolContext>({
    description: 'Run independent work in a fresh disposable context and return only its deliverable. Always provide objective, deliverable, and mode (inspect, research, implement, or validate); keep objective under 1000 characters; scope and acceptanceCriteria are optional. Use when private repository/log/docs/audit/debugging work would add much more context than the result needed here; one substantial task is enough. Use multiple calls for genuinely independent work. Do not use for trivial, sequential, user-interactive, shared-mutation, or unsummarized conversation-dependent work.',
    inputSchema: subagentInputSchema,
    execute: async (rawInput, context): Promise<SubagentExecutionResult> => {
      const input = rawInput as SubagentToolInput;
      const id = coordinator.createId();
      const normalized = normalizeSubagentInput(input, id);
      const task = options.forceMode ? {...normalized, mode: options.forceMode} : normalized;
      if (options.blockedReason) return terminalResult(task, runtime, profile, 'policy_blocked', options.blockedReason);
      return await coordinator.submit({
        id, mode: task.mode, signal: context.abortSignal,
        run: ({signal, queueMs, deadlineExpired}) => runSubagent(task, {runtime, profile, abortSignal: signal, deadlineExpired, queueMs, session: options.session, mutationPolicy: options.mutationPolicy, ...(options.contextFiles ? {contextFiles: options.contextFiles} : {})}),
        terminal: (termination, queueMs) => terminalResult(task, runtime, profile, termination, termination === 'cancelled'
          ? 'Worker cancelled before completion.'
          : termination === 'deadline_exceeded'
            ? 'Worker deadline exceeded; underlying abort-ignoring work remains quarantined until it settles.'
            : 'Worker execution failed unexpectedly.', queueMs),
        terminationOf: result => result.capsule.termination,
      });
    },
    toModelOutput: ({output}) => ({type: 'json' as const, value: output.capsule as unknown as JSONValue}),
  });
}

export const internals = {toolSummary, toolOnlyStepCount, shouldForceSynthesis, validationFromOutput, SYNTHESIS_DIRECTIVE};
