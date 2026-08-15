import {type ModelMessage} from 'ai';
import {readContextFiles, type ContextFile} from '../../config/contextFiles.js';
import {runAgentTurn, type Message, type StreamCallbacks, type TokenUsage, type TurnCompletionEvidence, type TurnStatus} from './streaming.js';
import type {EffectiveReasoning, ReasoningLevel} from '../../core/agent/reasoningPolicy.js';
import {EMPTY_TOKEN_USAGE, accumulateTokenUsage} from '../chat/turnState.js';
import {type PromptSession} from '../../llm/systemPrompt.js';
import {readSettings} from '../../config/settings.js';
import {activeModel, modelSelector, resolveModelSelector} from '../../config/providers.js';
import {createLog, endLog, type LlmLog} from '../../core/log/llmLog.js';
import type {AgentEvent} from '../../core/agent/events.js';
import {findSession, restoreSessionState} from '../../core/session/sessionStore.js';
import {teardownBackgroundProcesses} from '../../core/process/backgroundRegistry.js';
import {MAX_TURN_DEADLINE_MS} from '../../core/agent/budgets.js';
import {NdjsonSink} from './ndjsonSink.js';

export type HeadlessOutput = 'text' | 'json' | 'stream-json';

export interface HeadlessOptions {
  prompt: string;
  modelOverride?: string;
  resumeSessionId?: string;
  output: HeadlessOutput;
  debug?: boolean;
  timeout?: string;
}

/** Pinned, documented usage shape emitted in `--output json` (avoids leaking internal estimates). */
export interface HeadlessUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Estimated USD cost; present only when the model carries pricing metadata (F-12). */
  costUsd?: number;
}

type HeadlessStreamEvent =
  | {type: 'turn_start'; request: string; at: string}
  | {type: 'turn_end'; request: string; status: TurnStatus; evidence?: TurnCompletionEvidence; at: string}
  | {type: 'step_start'; attempt: number; step: number; at: string}
  | {type: 'step_end'; attempt: number; step: number; finishReason: string; toolCallCount: number; usage: HeadlessUsage; at: string}
  | {type: 'message_start'; id: string; role: 'assistant'; at: string}
  | {type: 'message_update'; id: string; delta: string; offset: number; at: string}
  | {type: 'message_end'; id: string; text: string; hidden?: boolean; at: string}
  | {type: 'tool_start'; id: string; name: string; at: string}
  | {type: 'tool_end'; id: string; name: string; success: boolean; durationMs: number; errorCode?: string; error?: string; at: string}
  | {type: 'retry'; attempt: number; maxAttempts: number; delayMs: number; error: string; at: string}
  | {type: 'reasoning_policy'; requested?: ReasoningLevel; effective: EffectiveReasoning; reason: string; at: string}
  | {type: 'context_budget'; contextWindowTokens: number; source: 'settings' | 'user-fallback' | 'default-fallback'; at: string}
  | {type: 'context_overflow'; recovered: boolean; error: string; at: string}
  | {type: 'timeout'; phase: 'turn' | 'tool' | 'model-stream'; timeoutMs: number; at: string};

function pinnedUsage(usage: TokenUsage): HeadlessUsage {
  // Normalize every field to a number: TokenUsage seeds most fields to 0 but
  // inputTokens/outputTokens may be undefined until the first report. A uniform ?? 0
  // keeps the documented CI contract literal (all five fields always present).
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    ...(usage.costUsd !== undefined ? {costUsd: Math.round(usage.costUsd * 1e6) / 1e6} : {}),
  };
}

/** Parse a `--timeout` duration like `30s`, `10m`, `2h`, or raw ms. Throws on invalid input. */
export function parseTurnTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw.trim());
  if (!match) throw new Error(`Invalid --timeout '${raw}'. Use a number with optional ms/s/m/h units (e.g. 30s, 10m, 2h).`);
  const value = Number(match[1]);
  const unit = match[2] ?? 'ms';
  const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  const ms = Math.round(value * multiplier);
  if (ms < 1000) throw new Error(`--timeout must be at least 1 second (got ${ms}ms).`);
  if (ms > MAX_TURN_DEADLINE_MS) throw new Error(`--timeout must be at most 24 hours (got ${ms}ms).`);
  return ms;
}

function errorText(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  const normalized = value.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 499)}…`;
}

function toHeadlessStreamEvent(event: AgentEvent): HeadlessStreamEvent | undefined {
  switch (event.type) {
    case 'turn_start':
      return {type: 'turn_start', request: event.request, at: event.at};
    case 'turn_end':
      return {...(event.evidence ? {evidence: event.evidence} : {}), type: 'turn_end', request: event.request, status: event.status, at: event.at};
    case 'step_start':
      return {type: 'step_start', attempt: event.attempt, step: event.step, at: event.at};
    case 'step_end':
      return {type: 'step_end', attempt: event.attempt, step: event.step, finishReason: event.finishReason, toolCallCount: event.toolCallCount, usage: event.usage, at: event.at};
    case 'message_start':
      return {type: 'message_start', id: event.id, role: event.role, at: event.at};
    case 'message_update':
      // Handled directly in emitStreamEvent with delta tracking; this case is
      // unreachable but kept for type exhaustiveness.
      return undefined;
    case 'message_end':
      return {...(event.hidden === undefined ? {} : {hidden: event.hidden}), type: 'message_end', id: event.id, text: event.text, at: event.at};
    case 'tool_start':
      // Intentionally omit raw tool input: stdout is often persisted by harnesses/CI.
      return {type: 'tool_start', id: event.id, name: event.name, at: event.at};
    case 'tool_end':
      return {type: 'tool_end', id: event.id, name: event.name, success: event.success, durationMs: event.durationMs, ...(event.errorCode === undefined ? {} : {errorCode: event.errorCode}), ...(event.error === undefined ? {} : {error: errorText(event.error)}), at: event.at};
    case 'retry':
      return {type: 'retry', attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, error: event.error, at: event.at};
    case 'context_overflow':
      return {type: 'context_overflow', recovered: event.recovered, error: event.error, at: event.at};
    case 'timeout':
      return {type: 'timeout', phase: event.phase, timeoutMs: event.timeoutMs, at: event.at};
    case 'reasoning_policy':
      return {...(event.requested ? {requested: event.requested} : {}), type: 'reasoning_policy', effective: event.effective, reason: event.reason, at: event.at};
    case 'context_budget':
      return {type: 'context_budget', contextWindowTokens: event.contextWindowTokens, source: event.source, at: event.at};
  }
}

function writeNdjson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Apply a cumulative-text message_update as a delta against the last emitted text for the segment. */
function messageUpdateDelta(event: Extract<AgentEvent, {type: 'message_update'}>, emitted: Map<string, string>): {type: 'message_update'; id: string; delta: string; offset: number; at: string} | undefined {
  const prev = emitted.get(event.id) ?? '';
  // Delta from the last emitted text. If display sanitization reset the suffix,
  // re-emit from offset 0 so consumers can reconstruct the exact final text.
  const delta = event.text.startsWith(prev) ? event.text.slice(prev.length) : event.text;
  const offset = event.text.startsWith(prev) ? prev.length : 0;
  emitted.set(event.id, event.text);
  if (delta.length === 0) return undefined;
  return {type: 'message_update', id: event.id, delta, offset, at: event.at};
}

/**
 * Resolve the model the run will use *before* invoking the agent, so a bad `--model`
 * selector or a missing provider produces a precise error (not the generic no-provider
 * message) with a non-zero exit. Returns an error string when the run cannot proceed.
 */
async function resolveModelOrError(modelOverride?: string): Promise<string | undefined> {
  const settings = await readSettings();
  const override = modelOverride?.trim();
  if (override) {
    const resolved = resolveModelSelector(settings, override);
    if (resolved.status === 'ambiguous') {
      return `Model ${resolved.model} exists on multiple providers: ${resolved.providers.map((provider) => modelSelector(provider, resolved.model)).join(', ')}`;
    }
    if (resolved.status === 'missing') {
      return `No configured model named ${override}. Run /provider, select a provider, then add models.`;
    }
    return undefined;
  }
  if (!activeModel(settings)) {
    return 'No model provider configured. Run /provider to choose or add a provider.';
  }
  return undefined;
}

export async function runHeadless(options: HeadlessOptions): Promise<number> {
  let turnDeadlineMs: number | undefined;
  try {
    turnDeadlineMs = parseTurnTimeoutMs(options.timeout);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const resumed = options.resumeSessionId ? await findSession(options.resumeSessionId) : undefined;
  if (options.resumeSessionId && !resumed) {
    process.stderr.write(`No session named ${options.resumeSessionId} exists for this workspace.\n`);
    return 1;
  }
  const modelError = await resolveModelOrError(options.modelOverride);
  if (modelError) {
    process.stderr.write(`${modelError}\n`);
    return 1;
  }

  // stderr keeps stdout clean for --output json/stream-json consumers.
  const debugLog = (line: string) => {
    if (options.debug) process.stderr.write(`[haze] ${line}\n`);
  };

  const contextFiles: ContextFile[] = await readContextFiles(process.cwd());
  const session: PromptSession = {start: new Date(), cwd: process.cwd()};
  let conversation: ModelMessage[] = [];
  if (resumed) {
    const restored = await restoreSessionState(resumed);
    conversation = restored.messages;
    for (const error of restored.parseErrors) process.stderr.write(`Session parse error: ${error}\n`);
  }
  // Assistant text is delivered in two stages by runAgentTurn: an initial streaming
  // `addMessage`, then a finalizing `updateMessage` with the complete text. We key
  // segments by id and patch them on update so finalized (and multi-segment) text is captured.
  const segments: {id?: string; text: string; hidden?: boolean}[] = [];
  let lastAssistantText = '';
  let usage: TokenUsage = {...EMPTY_TOKEN_USAGE};
  let log: LlmLog | undefined;
  if (options.debug) log = await createLog();
  const streamSink = options.output === 'stream-json' ? new NdjsonSink(process.stdout) : undefined;
  // Last cumulative text emitted per segment, used to derive deltas (RH-006) so
  // the total stream-json update payload is linear in the final text size.
  const emittedSegmentText = new Map<string, string>();
  const emitStreamEvent = options.output === 'stream-json' && streamSink
    ? (event: AgentEvent) => {
        if (event.type === 'message_update') {
          const delta = messageUpdateDelta(event, emittedSegmentText);
          if (delta) void streamSink.write(delta);
          return;
        }
        if (event.type === 'message_end') emittedSegmentText.delete(event.id);
        const headlessEvent = toHeadlessStreamEvent(event);
        if (headlessEvent) void streamSink.write(headlessEvent);
      }
    : undefined;

  const callbacks: StreamCallbacks = {
    addMessage: (msg: Message) => {
      if (msg.role === 'assistant') segments.push({id: msg.id, text: msg.text, hidden: msg.hidden});
    },
    updateMessage: (id: string, update: Partial<Message>) => {
      const segment = segments.find((s) => s.id === id);
      if (!segment) return;
      if (update.text !== undefined) segment.text = update.text;
      if (update.hidden !== undefined) segment.hidden = update.hidden;
    },
    setConversation: (msgs: ModelMessage[]) => {
      conversation = msgs;
    },
    setBusy: () => undefined,
    setBusyLabel: () => undefined,
    debugLog,
    getConversation: () => conversation,
    getLastAssistantText: () => lastAssistantText,
    setLastAssistantText: (text: string) => {
      lastAssistantText = text;
    },
    recordTokenUsage: (u: TokenUsage) => {
      usage = accumulateTokenUsage(usage, u);
    },
    onEvent: emitStreamEvent,
    log,
  };

  let status: TurnStatus;
  let result: string;
  let evidence: TurnCompletionEvidence | undefined;
  let persistenceError: string | undefined;
  let backgroundTeardownError: string | undefined;
  try {
    ({status, evidence} = await runAgentTurn(options.prompt, options.prompt, contextFiles, callbacks, 0, false, false, session, options.modelOverride, turnDeadlineMs != null ? {turnDeadlineMs} : {}));
    result = segments.filter((s) => !s.hidden && s.text).map((s) => s.text).join('\n');
  } catch (error) {
    status = 'failed';
    result = error instanceof Error ? error.message : String(error);
  } finally {
    await teardownBackgroundProcesses().catch(error => {
      backgroundTeardownError = error instanceof Error ? error.message : String(error);
    });
    if (log) await endLog(log).catch(error => {
      persistenceError = error instanceof Error ? error.message : String(error);
    });
  }
  if (backgroundTeardownError) process.stderr.write(`haze background teardown warning: ${backgroundTeardownError}\n`);
  if (persistenceError) process.stderr.write(`haze persistence warning: ${persistenceError}\n`);

  if (options.output === 'json' || options.output === 'stream-json') {
    // For stream-json the authoritative agent events have already streamed; flush
    // them before the terminal result so ordering is preserved under backpressure.
    if (streamSink) await streamSink.flush().catch(() => undefined);
    // This terminal line is byte-identical to the --output json envelope, so harnesses can parse the last line the same way.
    const resultLine = {type: 'result', status, result, usage: pinnedUsage(usage), ...(evidence ? {evidence} : {})};
    if (streamSink) await streamSink.write(resultLine).catch(() => undefined);
    else writeNdjson(resultLine);
    if (streamSink) await streamSink.flush().catch(() => undefined);
  } else if (status === 'complete') {
    process.stdout.write(result + (result.endsWith('\n') ? '' : '\n'));
  } else {
    process.stderr.write(`${result || `Turn ${status}.`}\n`);
  }
  return status === 'complete' ? 0 : 1;
}
