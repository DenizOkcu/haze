import React, {useEffect, useState} from 'react';
import {Box, render, Text, useApp, useStdout} from 'ink';
import Spinner from 'ink-spinner';
import {stepCountIs, streamText} from 'ai';
import {model} from '../../llm/client.js';
import {hazeTools} from '../../llm/hazeTools.js';
import {addInputHistoryItem, readInputHistory} from '../../config/inputHistory.js';
import {readSettings, updateSettings, type HazeSettings} from '../../config/settings.js';
import {Header} from '../../ui/components/Header.js';
import {TextInput} from '../../ui/components/TextInput.js';
import {MarkdownText} from '../../ui/components/MarkdownText.js';
import {theme} from '../../ui/theme.js';

type Message = {role: 'system' | 'user' | 'assistant'; text: string; streaming?: boolean};
type Mode = 'chat' | 'apiKey' | 'model';

function ChatScreen() {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const height = stdout.rows ?? process.stdout.rows ?? 24;
  const [messages, setMessages] = useState<Message[]>([
    {role: 'system', text: 'Welcome to Haze. Use /login for OpenRouter, /model to choose a model, /help for commands.'}
  ]);
  const [settings, setSettings] = useState<HazeSettings>({});
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>('chat');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    readSettings().then(setSettings).catch(() => undefined);
    readInputHistory().then(setInputHistory).catch(() => undefined);
  }, []);

  function persistInputHistory(value: string) {
    addInputHistoryItem(value).then(setInputHistory).catch(() => undefined);
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
    setMessages(m => [...m, userMessage]);
    setBusy(true);
    try {
      const m = model();
      if (!m) {
        setMessages(current => [...current, {role: 'assistant', text: 'No model configured. Run /login, then /model <model-name>. Haze cannot hallucinate without credentials. Progress.'}]);
        return;
      }
      const history = [...messages.filter(msg => msg.role !== 'system'), userMessage].slice(-12).map(msg => `${msg.role}: ${msg.text}`).join('\n');
      setMessages(current => [...current, {role: 'assistant', text: '', streaming: true}]);
      const result = streamText({
        model: m,
        system: 'You are Haze, a pragmatic AI agent CLI for helping users build apps. Be concise, technical, and practical. You can inspect and modify files with tools. Prefer readFile/editFile for targeted changes, writeFile for new or complete file rewrites, and bash for tests/builds/inspection. Ask before destructive actions.',
        prompt: history,
        tools: hazeTools,
        stopWhen: stepCountIs(10)
      });
      for await (const delta of result.textStream) {
        setMessages(current => current.map((message, index) => index === current.length - 1 ? {...message, text: message.text + delta} : message));
      }
      setMessages(current => current.map((message, index) => index === current.length - 1 ? {...message, streaming: false} : message));
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessages(current => [...current, {role: 'assistant', text: `Model call failed: ${text}`}]);
    } finally {
      setBusy(false);
    }
  }

  const visible = messages.slice(-18);
  const placeholder = mode === 'apiKey' ? 'OpenRouter API key...' : mode === 'model' ? 'openai/gpt-4o-mini' : busy ? 'Thinking, allegedly...' : 'Ask Haze to help build your app...';

  return <Box flexDirection="column" height={height}>
    <Box flexShrink={0}>
      <Header subtitle="AI agent CLI for building apps" />
    </Box>
    <Box flexDirection="column" flexGrow={1} minHeight={0}>
      {visible.map((message, index) => <Box key={index} flexDirection="column" marginBottom={1}>
        <Text color={message.role === 'user' ? theme.purple : message.role === 'assistant' ? theme.success : theme.muted} bold>
          {message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Haze' : 'Info'}
        </Text>
        {message.role === 'assistant' && !message.streaming ? <MarkdownText content={message.text} /> : <Text>{message.text}</Text>}
      </Box>)}
    </Box>
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

export async function chatCommand() {
  process.stdout.write('\u001B[?1049h\u001B[2J\u001B[H\u001B[?25l');
  const app = render(<ChatScreen />);
  await app.waitUntilExit();
  process.stdout.write('\u001B[?25h\u001B[?1049l');
}
