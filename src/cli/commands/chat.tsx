import React, {useEffect, useRef, useState} from 'react';
import {Box, render, Text, useApp, useStdout} from 'ink';
import Spinner from 'ink-spinner';
import {stepCountIs, streamText, type ModelMessage} from 'ai';
import {model} from '../../llm/client.js';
import {hazeTools} from '../../llm/hazeTools.js';
import {buildSystemPrompt} from '../../llm/systemPrompt.js';
import {addInputHistoryItem, readInputHistory} from '../../config/inputHistory.js';
import {readSettings, updateSettings, type HazeSettings} from '../../config/settings.js';
import {Header} from '../../ui/components/Header.js';
import {TextInput} from '../../ui/components/TextInput.js';
import {MarkdownText} from '../../ui/components/MarkdownText.js';
import {theme} from '../../ui/theme.js';

type Message = {id?: string; role: 'system' | 'user' | 'assistant' | 'tool'; text: string; streaming?: boolean};
type Mode = 'chat' | 'apiKey' | 'model';

interface ChatOptions {
  debug?: boolean;
}

function compact(value: unknown, maxLength = 180) {
  let text: string;
  if (value instanceof Error) {
    text = value.message;
  } else if (typeof value === 'string') {
    text = value;
  } else {
    text = JSON.stringify(value, (_key, nestedValue) => nestedValue instanceof Error ? nestedValue.message : nestedValue);
  }
  if (!text || text === '{}') return String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function toolCallSummary(toolName: string, input: unknown) {
  const data = input as Record<string, unknown>;
  if (toolName === 'bash' && typeof data?.command === 'string') {
    const timeout = typeof data.timeoutSeconds === 'number' ? ` (timeout ${data.timeoutSeconds}s)` : '';
    return `$ ${data.command}${timeout}`;
  }
  if (toolName === 'listFiles' && typeof data?.path === 'string') return `listFiles ${data.path}`;
  if ((toolName === 'readFile' || toolName === 'writeFile') && typeof data?.path === 'string') return `${toolName} ${data.path}`;
  if (toolName === 'editFile' && typeof data?.path === 'string') {
    const edits = Array.isArray(data.edits) ? ` (${data.edits.length} edit${data.edits.length === 1 ? '' : 's'})` : '';
    return `${toolName} ${data.path}${edits}`;
  }
  if (toolName === 'replaceLines' && typeof data?.path === 'string') return `replaceLines ${data.path}:${data.startLine}-${data.endLine}`;
  return `${toolName} ${compact(input)}`;
}

function toolResultSummary(event: {success: boolean; output?: unknown; error?: unknown}) {
  if (!event.success) return `failed: ${compact(event.error)}`;
  const output = event.output as Record<string, unknown> | undefined;
  if (typeof output?.code === 'number') return `exited with code ${output.code}`;
  if (typeof output?.ok === 'boolean') return output.ok ? 'completed' : `failed: ${compact(output)}`;
  return 'completed';
}

function formatSeconds(milliseconds: number) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function ChatScreen({debug = false}: ChatOptions) {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const height = stdout.rows ?? process.stdout.rows ?? 24;
  const [messages, setMessages] = useState<Message[]>([
    {role: 'system', text: 'Welcome to Haze. Use /login for OpenRouter, /model to choose a model, /help for commands.'}
  ]);
  const [settings, setSettings] = useState<HazeSettings>({});
  const [conversation, setConversation] = useState<ModelMessage[]>([]);
  const conversationRef = useRef<ModelMessage[]>([]);
  const lastAssistantTextRef = useRef('');
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>('chat');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    readSettings().then(setSettings).catch(() => undefined);
    readInputHistory().then(setInputHistory).catch(() => undefined);
  }, []);

  function persistInputHistory(value: string) {
    addInputHistoryItem(value).then(setInputHistory).catch(() => undefined);
  }

  function debugLog(line: string) {
    if (!debug) return;
    setDebugLogs(current => [...current.slice(-7), line]);
  }

  async function submit(value: string) {
    if (busy) return;

    if (mode === 'apiKey') {
      const next = await updateSettings({provider: 'openrouter', apiKey: value, baseURL: 'https://openrouter.ai/api/v1'});
      setSettings(next);
      setMode('chat');
      setMessages(m => [...m, {role: 'system', text: 'OpenRouter login saved to ~/.haze/settings.json. Security theatre completed.'}]);
      return;
    }

    if (mode === 'model') {
      const next = await updateSettings({model: value});
      setSettings(next);
      setMode('chat');
      setMessages(m => [...m, {role: 'system', text: `Model set to ${value}.`}]);
      return;
    }

    if (value === '/exit' || value === '/quit') return exit();
    if (value === '/help') {
      setMessages(m => [...m, {role: 'system', text: 'Commands: /login, /model <name>, /model, /settings, /clear, /exit'}]);
      return;
    }
    if (value === '/clear') {
      conversationRef.current = [];
      lastAssistantTextRef.current = '';
      setConversation([]);
      setMessages([{role: 'system', text: 'Cleared. The void is productive.'}]);
      return;
    }
    if (value === '/settings') {
      setMessages(m => [...m, {role: 'system', text: `Provider: ${settings.provider ?? 'not configured'} | Model: ${settings.model ?? 'not set'} | API key: ${settings.apiKey ? 'saved' : 'missing'}`}]);
      return;
    }
    if (value === '/login') {
      setMode('apiKey');
      setMessages(m => [...m, {role: 'system', text: 'Paste your OpenRouter API key. It will be stored in ~/.haze/settings.json.'}]);
      return;
    }
    if (value === '/model') {
      setMode('model');
      setMessages(m => [...m, {role: 'system', text: 'Enter an OpenRouter model name, e.g. openai/gpt-4o-mini or anthropic/claude-3.5-sonnet.'}]);
      return;
    }
    if (value.startsWith('/model ')) {
      const modelName = value.slice('/model '.length).trim();
      const next = await updateSettings({model: modelName});
      setSettings(next);
      setMessages(m => [...m, {role: 'system', text: `Model set to ${modelName}.`}]);
      return;
    }
    if (value.startsWith('/')) {
      setMessages(m => [...m, {role: 'system', text: `Unknown command: ${value}. Bold start.`}]);
      return;
    }

    const userMessage: Message = {role: 'user', text: value};
    setDebugLogs([]);
    setMessages(m => [...m, userMessage]);
    setBusy(true);
    try {
      const m = model();
      if (!m) {
        setMessages(current => [...current, {role: 'assistant', text: 'No model configured. Run /login, then /model <model-name>. Haze cannot hallucinate without credentials. Progress.'}]);
        return;
      }
      const refersToPrevious = /\b(this|that|previous|above|it)\b/i.test(value) && lastAssistantTextRef.current.trim().length > 0;
      const userContent = refersToPrevious
        ? `${value}\n\nReferenced previous Haze response to preserve exactly:\n${lastAssistantTextRef.current}`
        : value;
      const requestMessages: ModelMessage[] = [...conversationRef.current, {role: 'user', content: userContent}];
      conversationRef.current = requestMessages;
      setConversation(requestMessages);
      const assistantId = `assistant-${Date.now()}`;
      let assistantStarted = false;
      let assistantText = '';
      let editFileFailed = false;
      let mutatingToolSucceeded = false;
      const toolSummaries: string[] = [];
      debugLog(`request started with ${requestMessages.length} conversation messages${refersToPrevious ? ' and previous-response reference' : ''}`);
      const result = streamText({
        model: m,
        system: buildSystemPrompt(),
        messages: requestMessages,
        tools: hazeTools,
        stopWhen: stepCountIs(15),
        prepareStep() {
          if (mutatingToolSucceeded) return {toolChoice: 'none'};
          if (editFileFailed) return {activeTools: ['listFiles', 'readFile', 'replaceLines', 'writeFile', 'bash'] as Array<keyof typeof hazeTools>};
          return undefined;
        },
        onStepFinish({stepNumber, text, toolCalls, toolResults, finishReason}) {
          debugLog(`step ${stepNumber} finished: ${finishReason}; text=${text.length}; toolCalls=${toolCalls.length}; toolResults=${toolResults.length}`);
        },
        onFinish({response}) {
          const nextConversation = [...requestMessages, ...response.messages];
          conversationRef.current = nextConversation;
          setConversation(nextConversation);
          debugLog(`conversation updated to ${nextConversation.length} messages`);
        },
        experimental_onToolCallStart({toolCall}) {
          const text = toolCallSummary(toolCall.toolName, toolCall.input);
          setMessages(current => [...current, {id: `tool-${toolCall.toolCallId}`, role: 'tool', text, streaming: true}]);
          debugLog(`tool start: ${toolCall.toolName} ${compact(toolCall.input)}`);
        },
        experimental_onToolCallFinish(event) {
          const summary = toolResultSummary(event);
          const text = `${toolCallSummary(event.toolCall.toolName, event.toolCall.input)}\n${event.success ? '✓' : '✗'} ${summary} in ${formatSeconds(event.durationMs)}`;
          if (!event.success && event.toolCall.toolName === 'editFile') editFileFailed = true;
          if (event.success && ['editFile', 'replaceLines', 'writeFile'].includes(event.toolCall.toolName)) mutatingToolSucceeded = true;
          toolSummaries.push(`${event.toolCall.toolName}: ${summary}`);
          setMessages(current => current.map(message => message.id === `tool-${event.toolCall.toolCallId}` ? {...message, text, streaming: false} : message));
          debugLog(event.success
            ? `tool done: ${event.toolCall.toolName} after ${event.durationMs}ms ${compact(event.output)}`
            : `tool error: ${event.toolCall.toolName} after ${event.durationMs}ms ${compact(event.error)}`);
        }
      });
      for await (const delta of result.textStream) {
        assistantText += delta;
        if (!assistantStarted) {
          assistantStarted = true;
          setMessages(current => [...current, {id: assistantId, role: 'assistant', text: delta, streaming: true}]);
        } else {
          setMessages(current => current.map(message => message.id === assistantId ? {...message, text: message.text + delta} : message));
        }
      }
      debugLog(`response stream finished; session has ${conversationRef.current.length || conversation.length} model messages`);
      if (assistantStarted) {
        lastAssistantTextRef.current = assistantText.trim();
        setMessages(current => current.map(message => message.id === assistantId ? {...message, streaming: false} : message));
      } else {
        const fallback = toolSummaries.length > 0
          ? `Finished tool work but the model did not produce a final response. Last tool result: ${toolSummaries.at(-1)}.`
          : 'Finished without a text response.';
        setMessages(current => [...current, {id: assistantId, role: 'assistant', text: fallback, streaming: false}]);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      debugLog(`error: ${text}`);
      setConversation(conversationRef.current);
      setMessages(current => [...current, {role: 'assistant', text: `Model call failed: ${text}`}]);
    } finally {
      setBusy(false);
    }
  }

  const visible = messages;
  const placeholder = mode === 'apiKey' ? 'OpenRouter API key...' : mode === 'model' ? 'openai/gpt-4o-mini' : busy ? 'Thinking, allegedly...' : 'Ask Haze to help build your app...';

  return <Box flexDirection="column" minHeight={height}>
    <Box flexShrink={0}>
      <Header subtitle="AI agent CLI for building apps" />
    </Box>
    <Box flexDirection="column" flexGrow={1}>
      {visible.map((message, index) => <Box key={index} flexDirection="column" marginBottom={1}>
        <Text color={message.role === 'user' ? theme.purple : message.role === 'assistant' ? theme.success : message.role === 'tool' ? theme.muted : theme.muted} bold>
          {message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Haze' : message.role === 'tool' ? 'Tool' : 'Info'}
        </Text>
        {message.role === 'assistant' && !message.streaming ? <MarkdownText content={message.text} /> : <Text color={message.role === 'tool' ? theme.muted : undefined}>{message.streaming && message.role === 'tool' ? <><Spinner type="dots" /> {message.text}</> : message.text}</Text>}
      </Box>)}
    </Box>
    {debug && debugLogs.length > 0 && <Box flexDirection="column" flexShrink={0} marginBottom={1} borderStyle="round" borderColor={theme.muted} paddingX={1}>
      <Text color={theme.muted} bold>Debug</Text>
      {debugLogs.map((line, index) => <Text key={index} color={theme.muted}>• {line}</Text>)}
    </Box>}
    {busy && <Box flexShrink={0} marginBottom={1}>
      <Text color={theme.muted}><Spinner type="dots" /> Haze is thinking...</Text>
    </Box>}
    <Box borderStyle="round" borderColor={theme.deepPurple} paddingX={1} height={3} flexShrink={0}>
      <Box flexGrow={1} minWidth={0}>
        <TextInput
          placeholder={placeholder}
          disabled={busy}
          mask={mode === 'apiKey'}
          historyItems={inputHistory}
          recordHistory={mode === 'chat'}
          onHistoryAdd={persistInputHistory}
          onSubmit={submit}
        />
      </Box>
    </Box>
  </Box>;
}

export async function chatCommand(options: ChatOptions = {}) {
  const app = render(<ChatScreen debug={options.debug} />);
  await app.waitUntilExit();
}
