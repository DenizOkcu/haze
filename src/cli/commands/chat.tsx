import React, {useEffect, useRef, useState} from 'react';
import {Box, render, Text, useApp, useStdout} from 'ink';
import Spinner from 'ink-spinner';
import {type ModelMessage} from 'ai';
import {readContextFiles, type ContextFile} from '../../config/contextFiles.js';
import {addInputHistoryItem, readInputHistory} from '../../config/inputHistory.js';
import {readSettings, updateSettings, type HazeSettings} from '../../config/settings.js';
import {Header} from '../../ui/components/Header.js';
import {TextInput} from '../../ui/components/TextInput.js';
import {MarkdownText} from '../../ui/components/MarkdownText.js';
import {theme} from '../../ui/theme.js';
import {handleSlashCommand, type CommandContext} from './commands.js';
import {runAgentTurn, type Message} from './streaming.js';

export type Mode = 'chat' | 'apiKey' | 'model';

interface ChatOptions {
  debug?: boolean;
}

function ChatScreen({debug = false}: ChatOptions) {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const height = stdout.rows ?? process.stdout.rows ?? 24;
  const [messages, setMessages] = useState<Message[]>([
    {role: 'system', text: 'Welcome to Haze. Use /login for OpenRouter, /model to choose a model, /help for commands.'}
  ]);
  const [settings, setSettings] = useState<HazeSettings>({});
  const conversationRef = useRef<ModelMessage[]>([]);
  const lastAssistantTextRef = useRef('');
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  const [mode, setMode] = useState<Mode>('chat');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    readSettings().then(setSettings).catch(() => undefined);
    readInputHistory().then(setInputHistory).catch(() => undefined);
    readContextFiles().then(setContextFiles).catch(() => undefined);
  }, []);

  function persistInputHistory(value: string) {
    addInputHistoryItem(value).then(setInputHistory).catch(() => undefined);
  }

  function debugLog(line: string) {
    if (!debug) return;
    setDebugLogs(current => [...current.slice(-7), line]);
  }

  function clearConversation() {
    conversationRef.current = [];
    lastAssistantTextRef.current = '';
    setMessages([{role: 'system', text: 'Cleared. The void is productive.'}]);
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

    const ctx: CommandContext = {
      settings,
      contextFiles,
      setMode,
      addSystemMessage: text => setMessages(m => [...m, {role: 'system', text}]),
      clearConversation,
      runAgentTurn: (prompt, displayValue) => doAgentTurn(prompt, displayValue),
      refreshContextFiles: async () => { const files = await readContextFiles().catch(() => contextFiles); setContextFiles(files); return files; },
      updateSettings: patch => { const next = {...settings, ...patch}; setSettings(next); return Promise.resolve(next); },
    };
    const result = await handleSlashCommand(value, ctx);
    if (result === 'exit') return exit();
    if (result === 'handled') return;

    await doAgentTurn(value);
  }

  async function doAgentTurn(value: string, displayValue?: string) {
    setDebugLogs([]);
    await runAgentTurn(value, displayValue, contextFiles, {
      addMessage: msg => setMessages(m => [...m, msg]),
      updateMessage: (id, update) => setMessages(m => m.map(msg => msg.id === id ? {...msg, ...update} : msg)),
      setConversation: msgs => { conversationRef.current = msgs; },
      setBusy,
      debugLog,
      getConversation: () => conversationRef.current,
      getLastAssistantText: () => lastAssistantTextRef.current,
      setLastAssistantText: text => { lastAssistantTextRef.current = text; },
    });
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
