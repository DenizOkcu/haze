import {type ModelMessage} from 'ai';
import {readContextFiles, type ContextFile} from '../../config/contextFiles.js';
import {runAgentTurn, type Message, type StreamCallbacks, type TokenUsage, type TurnStatus} from './streaming.js';
import {EMPTY_TOKEN_USAGE, accumulateTokenUsage} from '../chat/turnState.js';
import {type PromptSession} from '../../llm/systemPrompt.js';
import {readSettings} from '../../config/settings.js';
import {activeModel, modelSelector, resolveModelSelector} from '../../config/providers.js';
import {createLog, endLog, type LlmLog} from '../../core/log/llmLog.js';

export type HeadlessOutput = 'text' | 'json';

export interface HeadlessOptions {
  prompt: string;
  modelOverride?: string;
  output: HeadlessOutput;
  debug?: boolean;
}

/** Pinned, documented usage shape emitted in `--output json` (avoids leaking internal estimates). */
export interface HeadlessUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

function debug(line: string) {
  if (process.env.HAZE_DEBUG) process.stderr.write(`[haze] ${line}\n`);
}

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
  };
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
  const modelError = await resolveModelOrError(options.modelOverride);
  if (modelError) {
    process.stderr.write(`${modelError}\n`);
    return 1;
  }

  const contextFiles: ContextFile[] = await readContextFiles(process.cwd());
  const session: PromptSession = {start: new Date(), cwd: process.cwd()};
  let conversation: ModelMessage[] = [];
  // Assistant text is delivered in two stages by runAgentTurn: an initial streaming
  // `addMessage`, then a finalizing `updateMessage` with the complete text. We key
  // segments by id and patch them on update so finalized (and multi-segment) text is captured.
  const segments: {id?: string; text: string; hidden?: boolean}[] = [];
  let lastAssistantText = '';
  let usage: TokenUsage = {...EMPTY_TOKEN_USAGE};
  let log: LlmLog | undefined;
  if (options.debug) log = await createLog();

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
    debugLog: debug,
    getConversation: () => conversation,
    getLastAssistantText: () => lastAssistantText,
    setLastAssistantText: (text: string) => {
      lastAssistantText = text;
    },
    recordTokenUsage: (u: TokenUsage) => {
      usage = accumulateTokenUsage(usage, u);
    },
    log,
  };

  let status: TurnStatus;
  let result: string;
  try {
    ({status} = await runAgentTurn(options.prompt, options.prompt, contextFiles, callbacks, 0, false, false, session, options.modelOverride));
    result = segments.filter((s) => !s.hidden && s.text).map((s) => s.text).join('\n');
  } catch (error) {
    status = 'failed';
    result = error instanceof Error ? error.message : String(error);
  } finally {
    if (log) await endLog(log).catch(() => undefined);
  }

  if (options.output === 'json') {
    process.stdout.write(JSON.stringify({type: 'result', status, result, usage: pinnedUsage(usage)}) + '\n');
  } else if (status === 'complete') {
    process.stdout.write(result + (result.endsWith('\n') ? '' : '\n'));
  } else {
    process.stderr.write(`${result || `Turn ${status}.`}\n`);
  }
  return status === 'complete' ? 0 : 1;
}
