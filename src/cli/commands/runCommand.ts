import {type ModelMessage} from 'ai';
import {readContextFiles, type ContextFile} from '../../config/contextFiles.js';
import {runAgentTurn, type Message, type TokenUsage} from './streaming.js';
import {EMPTY_TOKEN_USAGE, accumulateTokenUsage} from '../chat/turnState.js';
import {type PromptSession} from '../../llm/systemPrompt.js';

export type HeadlessOutput = 'text' | 'json';

export interface HeadlessOptions {
  prompt: string;
  modelOverride?: string;
  output: HeadlessOutput;
  debug?: boolean;
}

export interface HeadlessResult {
  result: string;
  status: 'complete' | 'aborted' | 'failed';
  usage: TokenUsage;
}

function debug(line: string) {
  if (process.env.HAZE_DEBUG) process.stderr.write(`[haze] ${line}\n`);
}

export async function runHeadless(options: HeadlessOptions): Promise<number> {
  const contextFiles: ContextFile[] = await readContextFiles(process.cwd());
  const session: PromptSession = {start: new Date(), cwd: process.cwd()};
  let conversation: ModelMessage[] = [];
  const segments: {id?: string; text: string; hidden?: boolean}[] = [];
  let lastAssistantText = '';
  let usage: TokenUsage = {...EMPTY_TOKEN_USAGE};

  const callbacks = {
    addMessage: (msg: Message) => {
      if (msg.role === 'assistant' && !msg.hidden && msg.text) segments.push({id: msg.id, text: msg.text, hidden: msg.hidden});
    },
    updateMessage: () => undefined,
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
  };

  try {
    await runAgentTurn(options.prompt, options.prompt, contextFiles, callbacks as never, 0, false, false, session, options.modelOverride);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (options.output === 'json') {
      process.stdout.write(JSON.stringify({type: 'result', result: '', status: 'failed', error: text, usage}) + '\n');
    } else {
      process.stderr.write(`Model call failed: ${text}\n`);
    }
    return 1;
  }

  const result = segments.map((s) => s.text).join('\n');
  const noModel = /No model provider configured/.test(result);

  if (noModel) {
    process.stderr.write(`${result || 'No model provider configured. Run /provider to choose or add a provider.'}\n`);
    return 1;
  }

  if (options.output === 'json') {
    const envelope = {type: 'result', status: 'complete', result, usage};
    process.stdout.write(JSON.stringify(envelope) + '\n');
  } else {
    process.stdout.write(result + (result.endsWith('\n') ? '' : '\n'));
  }
  return 0;
}