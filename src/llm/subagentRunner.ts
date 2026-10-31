import {isStepCount, streamText, tool, type JSONValue, type ModelMessage} from 'ai';
import {calculateRequestTokenBudget, estimateMessagesTokens, estimateValueTokens} from '../core/agent/contextBudget.js';
import {compactModelMessages} from '../core/agent/compaction.js';
import {
  SUBAGENT_SYNTHESIS_RESERVE,
  SUBAGENT_TOOL_ONLY_LIMIT,
  createToolExecutionBudget,
  isToolBudgetBlocked,
  withToolExecutionBudget,
} from '../core/agent/budgets.js';
import {storeToolOutput} from '../core/agent/toolOutputStore.js';
import {changedPathsFromTool} from '../core/agent/toolCapabilities.js';
import {withSyntheticControl} from '../core/agent/requestAssembly.js';
import {scopedContextMessage} from '../config/contextFiles.js';
import {toolOnlyStepCount} from '../core/agent/turnPolicy.js';
import {toolsContextFor, type HazeToolContext} from './tools/toolContext.js';
import {assembleWorkerContext, workerTaskMessage, type WorkerContextBundle} from './workerContext.js';
import {
  fallbackWorkerRuntime,
  normalizeSubagentInput,
  subagentInputSchema,
  type SubagentExecutionResult,
  type SubagentResultCapsule,
  type SubagentTaskCapsule,
  type SubagentTelemetry,
  type SubagentToolInput,
  type WorkerRuntime,
  type WorkerTermination,
} from '../core/subagent/contracts.js';
import {COMPATIBILITY_PROFILE, type SubagentExecutionProfile} from '../core/subagent/executionProfiles.js';
import {SubagentCoordinator} from '../core/subagent/subagentCoordinator.js';
import {WorkspaceMutationPolicy} from '../core/subagent/workspaceMutationPolicy.js';
import {type PromptSession} from './systemPrompt.js';
import {resolveWorkspacePath, workspaceRelativePath} from '../utils/path.js';

class WorkerCapacityError extends Error {}

const SYNTHESIS_DIRECTIVE = 'You have reached your tool/step budget. Stop calling tools. Return the requested self-contained deliverable now, including evidence, coverage gaps, changed paths, validation, and precise remaining work. A concise partial deliverable is mandatory and better than an empty response.';

type SubagentStep = {toolCalls: unknown[]; text: string};

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

/**
 * Late-discovered scoped AGENTS.md/CLAUDE.md content rides an ordinary user
 * message with the standard `<project_instructions>` framing — never the
 * nonce'd `<haze_control>` channel, which stays engine-directives-only
 * (R2-HZ-3). Appended, never rewriting the in-flight provider prefix.
 */
function pendingScopedContext(messages: ModelMessage[], context: HazeToolContext) {
  const files = context.pendingContextFiles ?? [];
  if (files.length === 0) return messages;
  context.pendingContextFiles = [];
  return [...messages, scopedContextMessage('Additional scoped project instructions now apply. Follow them before subsequent work.', files)];
}

function validationFromOutput(name: string, output: unknown) {
  if (name !== 'shell' || typeof output !== 'object' || output == null) return undefined;
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
  return {capsule, telemetry, ...(termination === 'provider_error' || termination === 'policy_blocked' ? {error: message} : {})};
}

export type SubagentResult = SubagentExecutionResult;

export async function runSubagent(
  task: SubagentTaskCapsule,
  options: {
    model?: WorkerRuntime['model'];
    runtime?: WorkerRuntime;
    profile?: SubagentExecutionProfile;
    contextBundle?: WorkerContextBundle;
    abortSignal?: AbortSignal;
    deadlineExpired?: () => boolean;
    queueMs?: number;
    session?: PromptSession;
    mutationPolicy?: WorkspaceMutationPolicy;
  },
): Promise<SubagentExecutionResult> {
  const profile = options.profile ?? COMPATIBILITY_PROFILE;
  const runtime: WorkerRuntime = options.runtime ?? fallbackWorkerRuntime(options.model!);
  const maxSteps = profile.maxSteps;
  const outputTokens = Math.min(profile.maxOutputTokens, runtime.maxOutputTokens ?? profile.maxOutputTokens, Math.max(1, (runtime.contextWindowTokens ?? 128000) - 1000));
  const startedAt = performance.now();
  const bundle = options.contextBundle ?? await assembleWorkerContext(task, profile, options.session);
  if (bundle.policyBlock) return terminalResult(task, runtime, profile, 'policy_blocked', bundle.policyBlock, options.queueMs);
  const requestBudget = calculateRequestTokenBudget({contextWindowTokens: runtime.contextWindowTokens, requestedOutputTokens: outputTokens, system: bundle.systemPrompt, tools: bundle.tools});
  const messageBudget = Math.min(requestBudget.messageTokens, Math.max(0, profile.maxInputTokens - requestBudget.systemTokens - requestBudget.toolSchemaTokens));
  if (messageBudget < estimateValueTokens(workerTaskMessage(task))) return terminalResult(task, runtime, profile, 'policy_blocked', 'Worker task, instructions, tools and output do not fit the selected model capacity. Narrow the task/context.', options.queueMs);
  let inputEstimateRatio = 1;
  let lastInputEstimate = bundle.estimatedTokens;
  let capacityStop = false;
  let streamError: unknown;

  const toolCallLog: SubagentTelemetry['toolCalls'] = [];
  const changedPaths = new Set<string>();
  const validation: SubagentResultCapsule['validation'] = [];
  let usageIn: number | undefined;
  let usageOut: number | undefined;
  const toolBudget = createToolExecutionBudget();
  const budgetedTools = withToolExecutionBudget(bundle.tools, {state: toolBudget, limit: profile.maxToolCalls});
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
    // Workers always run with reasoning disabled. Session/main-turn reasoning
    // effort rides the inherited request options; on reasoning models its
    // hidden tokens count against the worker's bounded maxOutputTokens, so a
    // `high` session could burn the whole worker budget on thinking and return
    // `no_output` (observed live: glm-5.3 @ high reasoning, 2026-10-04).
    // Applied only when the worker protocol supports the option; other
    // protocols cannot express it and must keep the runtime unchanged.
    if (runtime.capabilities.supportsReasoningEffort || runtime.capabilities.supportsBinaryThinking) providerRequestOptions.reasoning = 'none';
    // Use the streaming model path even though workers return one collected
    // capsule. ChatGPT Codex's Responses endpoint requires `stream: true`;
    // `generateText` takes the non-streaming doGenerate path and is rejected.
    const result = await streamText({
      model: runtime.model,
      instructions: bundle.systemPrompt,
      messages: [{role: 'user', content: workerTaskMessage(task)}],
      tools: budgetedTools,
      stopWhen: isStepCount(maxSteps),
      ...(!omitMaxOutputTokens ? {maxOutputTokens: outputTokens} : {}),
      maxRetries: profile.maxRetries,
      ...providerRequestOptions,
      abortSignal: options.abortSignal,
      runtimeContext: toolExecutionContext,
      toolsContext: toolsContextFor(budgetedTools, toolExecutionContext) as never,
      prepareStep({steps, messages}) {
        let scopedMessages = pendingScopedContext(messages, toolExecutionContext);
        const target = Math.floor(messageBudget / inputEstimateRatio);
        if (estimateMessagesTokens(scopedMessages) > target) {
          const compacted = compactModelMessages(scopedMessages, {tokenBudget: Math.max(0, target - 512)});
          scopedMessages = compacted.messages;
          capacityStop = true;
          if (estimateMessagesTokens(scopedMessages) > target) throw new WorkerCapacityError('Worker history cannot fit the selected model capacity; narrow scope/context.');
        }
        lastInputEstimate = requestBudget.systemTokens + requestBudget.toolSchemaTokens + estimateMessagesTokens(scopedMessages);
        if (capacityStop) return {toolChoice: 'none' as const, messages: withSyntheticControl(scopedMessages, SYNTHESIS_DIRECTIVE)};
        if (!toolBudget.exceeded && toolBudget.started < profile.maxToolCalls && !shouldForceSynthesis(steps, maxSteps, profile.maxToolCalls)) return scopedMessages !== messages ? {messages: scopedMessages} : undefined;
        return {toolChoice: 'none' as const, messages: withSyntheticControl(scopedMessages, SYNTHESIS_DIRECTIVE)};
      },
      onError({error}) { streamError = error; },
      onStepEnd({usage}) {
        if (usage?.inputTokens && lastInputEstimate > 0) inputEstimateRatio = Math.max(inputEstimateRatio, usage.inputTokens / lastInputEstimate);
        if (typeof usage?.inputTokens === 'number') usageIn = (usageIn ?? 0) + usage.inputTokens;
        if (typeof usage?.outputTokens === 'number') usageOut = (usageOut ?? 0) + usage.outputTokens;
      },
      onToolExecutionEnd(event) {
        if (!event.toolCall) return;
        const output = event.toolOutput.type === 'tool-result' ? event.toolOutput.output : undefined;
        if (!isToolBudgetBlocked(output)) {
          const toolError = 'error' in event.toolOutput ? event.toolOutput.error : 'tool execution failed';
          if (toolCallLog.length < profile.maxToolCalls) toolCallLog.push({name: event.toolCall.toolName, summary: output === undefined ? `failed: ${String(toolError).slice(0, 120)}` : toolSummary(output), durationMs: event.toolExecutionMs});
          for (const changedPath of changedPathsFromTool(event.toolCall.toolName, event.toolCall.input, output)) {
            try { changedPaths.add(workspaceRelativePath(resolveWorkspacePath(changedPath))); } catch { /* Ignore invalid paths in external results. */ }
          }
          const validationRecord = validationFromOutput(event.toolCall.toolName, output);
          if (validationRecord && validation.length < profile.maxToolCalls) validation.push(validationRecord);
        }
      },
    });
    const [text, usage, steps] = await Promise.all([result.text, result.usage, result.steps]);
    if (streamError) throw streamError;
    usageIn = usage.inputTokens ?? usageIn;
    usageOut = usage.outputTokens ?? usageOut;
    const fullText = text.trim();
    const truncated = fullText.length > profile.maxSummaryChars;
    const resultHandle = truncated ? storeToolOutput(fullText) : undefined;
    const deliverable = fullText
      ? `${fullText.slice(0, profile.maxSummaryChars)}${truncated ? '\n\n[Result truncated; retrieve the non-durable resultHandle only if needed.]' : ''}`
      : 'Subagent completed without text output.';
    const totalToolCalls = toolBudget.started;
    const toolLimited = toolBudget.exceeded || totalToolCalls >= profile.maxToolCalls;
    const termination: WorkerTermination = options.deadlineExpired?.() ? 'deadline_exceeded'
      : options.abortSignal?.aborted ? 'cancelled'
        : capacityStop ? 'step_limit'
          : toolLimited ? 'tool_limit'
          : steps.length >= maxSteps && !fullText ? 'step_limit'
            : !fullText ? 'no_output'
              : 'completed';
    const capsule: SubagentResultCapsule = {id: task.id, termination, usable: fullText.length > 0, deliverable, changedPaths: [...changedPaths].sort(), validation, coverageGaps: capacityStop ? ['Worker reached its model context budget and returned a bounded synthesis.'] : [], truncated, ...(resultHandle ? {resultHandle} : {})};
    const durationMs = performance.now() - startedAt;
    const telemetry = telemetryBase(runtime, profile, bundle.taskTokens, bundle.estimatedTokens, options.queueMs);
    telemetry.durationMs = durationMs;
    telemetry.toolCallCount = totalToolCalls;
    telemetry.toolCalls = toolCallLog;
    telemetry.usage = {inputTokens: usageIn, outputTokens: usageOut};
    telemetry.estimates.privateContextTokens = (usageIn ?? bundle.estimatedTokens) + (usageOut ?? 0);
    telemetry.estimates.resultCapsuleTokens = estimateValueTokens(capsule);
    telemetry.estimates.mainContextTokensAvoided = Math.max(0, telemetry.estimates.privateContextTokens - telemetry.estimates.taskCapsuleTokens - telemetry.estimates.resultCapsuleTokens);
    return {capsule, telemetry};
  } catch (error) {
    // Bounded, actionable provider-failure capsule (RT-03): a worker that dies
    // before producing output must tell the parent model what happened and what
    // to do next — an empty deliverable (observed live: provider errors with no
    // message surfaced as `deliverable: ""`) leaves the parent guessing and
    // re-dispatching blind. Never echo provider bodies; bound the text.
    const rawMessage = error instanceof Error && error.message.trim().length > 0 ? error.message.trim() : 'the provider call failed before any output';
    const boundedMessage = rawMessage.length > 300 ? `${rawMessage.slice(0, 299)}…` : rawMessage;
    const capsuleMessage = error instanceof WorkerCapacityError
      ? `${boundedMessage} Narrow the task/context or do the remaining work in the main conversation; do not retry the same oversized input.`
      : `${boundedMessage}. No usable worker output was produced; retry this subagent once with the same task, or do the work directly in the main conversation.`;
    const termination: WorkerTermination = options.deadlineExpired?.() ? 'deadline_exceeded' : options.abortSignal?.aborted ? 'cancelled' : error instanceof WorkerCapacityError ? 'policy_blocked' : 'provider_error';
    const result = terminalResult(task, runtime, profile, termination, capsuleMessage, options.queueMs);
    // Keep the raw provider message on `error` so machine consumers see exactly
    // what the provider said (unchanged contract).
    result.error = rawMessage;
    result.capsule.changedPaths = [...changedPaths].sort();
    result.capsule.validation = [...validation];
    result.telemetry.estimates.resultCapsuleTokens = estimateValueTokens(result.capsule);
    result.telemetry.durationMs = performance.now() - startedAt;
    result.telemetry.toolCalls = toolCallLog;
    result.telemetry.toolCallCount = toolBudget.started;
    result.telemetry.usage = {inputTokens: usageIn, outputTokens: usageOut};
    return result;
  } finally {
    release?.();
  }
}

export function createSubagentTool(options: {
  model?: WorkerRuntime['model'];
  runtime?: WorkerRuntime;
  profile?: SubagentExecutionProfile;
  coordinator?: SubagentCoordinator;
  mutationPolicy?: WorkspaceMutationPolicy;
  blockedReason?: string;
  forceMode?: 'inspect';
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
        run: ({signal, queueMs, deadlineExpired}) => runSubagent(task, {runtime, profile, abortSignal: signal, deadlineExpired, queueMs, session: options.session, mutationPolicy: options.mutationPolicy}),
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

export const internals = {toolSummary, toolOnlyStepCount, shouldForceSynthesis, validationFromOutput, pendingScopedContext, SYNTHESIS_DIRECTIVE};
