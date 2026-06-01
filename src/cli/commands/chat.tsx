import React, {useEffect, useRef, useState} from 'react';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {Box, render, Text, useApp, useStdout} from 'ink';
import Spinner from 'ink-spinner';
import {type ModelMessage} from 'ai';
import {readContextFiles, type ContextFile} from '../../config/contextFiles.js';
import {addInputHistoryItem, readInputHistory} from '../../config/inputHistory.js';
import {readSettings, updateSettings, type HazeSettings} from '../../config/settings.js';
import {Header} from '../../ui/components/Header.js';
import {TextInput, type TextInputSuggestion} from '../../ui/components/TextInput.js';
import {MarkdownText} from '../../ui/components/MarkdownText.js';
import {theme} from '../../ui/theme.js';
import {handleSlashCommand, type CommandContext} from './commands.js';
import {runAgentTurn, type Message} from './streaming.js';
import {loadSkillRegistry} from '../../skills/SkillRegistry.js';
import type {LoadedSkill} from '../../skills/types.js';

export type Mode = 'chat' | 'apiKey' | 'model';

interface ChatOptions {
  debug?: boolean;
  version?: string;
}

const execFile = promisify(execFileCallback);

async function currentBranchName() {
  try {
    const {stdout} = await execFile('git', ['branch', '--show-current'], {cwd: process.cwd()});
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function toolCallCount(messages: Message[]) {
  return messages.reduce((total, message) => {
    if (message.role !== 'tool') return total;
    const headerCount = /Tools: (\d+) calls?/.exec(message.text)?.[1];
    if (headerCount) return total + Number(headerCount);
    const rows = message.text.split('\n').filter(line => /^\s+[✓✗…]\s/.test(line));
    return total + rows.reduce((rowTotal, row) => rowTotal + Number(/×(\d+)/.exec(row)?.[1] ?? 1), 0);
  }, 0);
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

function formatTokenCount(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(tokens);
}

function estimateConversationTokens(messages: Message[]) {
  const inputText = messages
    .filter(message => message.role === 'user' || message.role === 'tool')
    .map(message => message.text)
    .join('\n');
  const outputText = messages
    .filter(message => message.role === 'assistant')
    .map(message => message.text)
    .join('\n');
  return {
    input: estimateTokens(inputText),
    output: estimateTokens(outputText),
  };
}

function ToolMessageText({text, streaming}: {text: string; streaming?: boolean}) {
  const lines = text.split('\n');
  return <Box flexDirection="column">
    {lines.map((line, index) => {
      const row = /^(\s*)([✓✗…])\s+(\S+)(.*)$/.exec(line);
      if (!row) {
        return <Text key={`${index}-${line}`} color={theme.muted}>
          {index === 0 && streaming ? <><Spinner type="dots" /> </> : null}{line}
        </Text>;
      }
      const [, indent, icon, toolName, rest] = row;
      const iconColor = icon === '✓' ? theme.success : icon === '✗' ? theme.danger : theme.muted;
      return <Text key={`${index}-${line}`} color={theme.muted}>
        {indent}<Text color={iconColor}>{icon}</Text> <Text color={theme.purple}>{toolName}</Text>{rest}
      </Text>;
    })}
  </Box>;
}

function startupProviderInfo(settings: HazeSettings) {
  const model = process.env.HAZE_MODEL ?? settings.model ?? 'x-ai/grok-build-0.1';
  const modelSource = process.env.HAZE_MODEL ? 'HAZE_MODEL env' : settings.model ? 'settings' : 'default';
  const baseURL = process.env.OPENAI_BASE_URL ?? settings.baseURL ?? 'https://openrouter.ai/api/v1';
  const baseURLSource = process.env.OPENAI_BASE_URL ? 'OPENAI_BASE_URL env' : settings.baseURL ? 'settings' : 'default';
  const apiKeySource = process.env.OPENAI_API_KEY ? 'OPENAI_API_KEY env' : settings.apiKey ? '~/.haze/settings.json' : 'missing';
  const provider = process.env.OPENAI_BASE_URL
    ? 'OpenAI-compatible custom endpoint'
    : settings.provider === 'openrouter' || settings.baseURL || settings.apiKey
      ? 'OpenRouter'
      : 'OpenRouter (not logged in)';

  return [
    'Provider configuration',
    `- Provider: ${provider}`,
    `- Model: ${model} (${modelSource})`,
    `- Base URL: ${baseURL} (${baseURLSource})`,
    `- API key: ${apiKeySource === 'missing' ? 'not configured; run /login or set OPENAI_API_KEY' : `configured via ${apiKeySource}`}`,
  ].join('\n');
}

function ChatScreen({debug = false, version}: ChatOptions) {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const height = stdout.rows ?? process.stdout.rows ?? 24;
  const [messages, setMessages] = useState<Message[]>([
    {role: 'system', text: 'Welcome to Haze. Use /help for commands.'}
  ]);
  const [settings, setSettings] = useState<HazeSettings>({});
  const conversationRef = useRef<ModelMessage[]>([]);
  const lastAssistantTextRef = useRef('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  const [mode, setMode] = useState<Mode>('chat');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('Haze is thinking');
  const [skills, setSkills] = useState<LoadedSkill[]>([]);
  const [branchName, setBranchName] = useState<string | undefined>();

  useEffect(() => {
    Promise.all([readSettings(), currentBranchName()]).then(([next, branch]) => {
      setSettings(next);
      setBranchName(branch);
      setMessages(m => [...m, {role: 'system', text: startupProviderInfo(next)}]);
    }).catch(() => {
      currentBranchName().then(branch => {
        setBranchName(branch);
        setMessages(m => [...m, {role: 'system', text: startupProviderInfo({})}]);
      }).catch(() => {
        setMessages(m => [...m, {role: 'system', text: startupProviderInfo({})}]);
      });
    });
    readInputHistory().then(setInputHistory).catch(() => undefined);
    readContextFiles().then(setContextFiles).catch(() => undefined);
    refreshSkills().catch(() => undefined);
    const branchTimer = setInterval(() => {
      currentBranchName().then(setBranchName).catch(() => setBranchName(undefined));
    }, 3000);
    return () => clearInterval(branchTimer);
  }, []);

  function persistInputHistory(value: string) {
    addInputHistoryItem(value).then(setInputHistory).catch(() => undefined);
  }

  async function refreshSkills() {
    const registry = await loadSkillRegistry();
    const nextSkills = [...registry.skills.values()];
    setSkills(nextSkills);
    return nextSkills;
  }

  function skillInvocation(value: string) {
    if (!value.startsWith('/')) return undefined;
    const name = value.slice(1).trim();
    if (!name || name.includes(' ')) return undefined;
    return skills.find(skill => skill.name === name);
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

  function cancelThinking() {
    if (!busy) return;
    abortControllerRef.current?.abort('User pressed Esc.');
    setBusy(false);
  }

  async function submit(value: string) {
    if (busy) return;

    if (mode === 'apiKey') {
      const next = await updateSettings({provider: 'openrouter', apiKey: value, baseURL: 'https://openrouter.ai/api/v1'});
      setSettings(next);
      setMode('chat');
      setMessages(m => [...m, {role: 'system', text: `OpenRouter login saved to ~/.haze/settings.json. Security theatre completed.\n\n${startupProviderInfo(next)}`}]);
      return;
    }

    if (mode === 'model') {
      const next = await updateSettings({model: value});
      setSettings(next);
      setMode('chat');
      setMessages(m => [...m, {role: 'system', text: `Model set to ${value}.\n\n${startupProviderInfo(next)}`}]);
      return;
    }

    const invokedSkill = skillInvocation(value);
    if (invokedSkill) {
      await doAgentTurn(`The user explicitly invoked the "${invokedSkill.name}" skill. Call skill_${invokedSkill.name.replace(/[^a-zA-Z0-9_]/g, '_')} and follow its returned instructions.`, value);
      return;
    }

    const isSkillCreate = /^\/skills? create(?:\s|$)/.test(value);

    const ctx: CommandContext = {
      settings,
      contextFiles,
      setMode,
      addSystemMessage: text => setMessages(m => [...m, {role: 'system', text}]),
      clearConversation,
      runAgentTurn: (prompt, displayValue) => doAgentTurn(prompt, displayValue),
      refreshContextFiles: async () => { const files = await readContextFiles().catch(() => contextFiles); setContextFiles(files); return files; },
      updateSettings: async patch => {
        const next = await updateSettings(patch);
        setSettings(next);
        return next;
      },
    };
    let result;
    if (isSkillCreate) {
      setBusyLabel('Creating skill');
      setBusy(true);
    }
    try {
      result = await handleSlashCommand(value, ctx);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessages(m => [...m, {role: 'system', text: `Skill creation failed: ${text}`}]);
      return;
    } finally {
      if (isSkillCreate) {
        setBusy(false);
        setBusyLabel('Haze is thinking');
      }
    }
    if (result === 'exit') return exit();
    if (result === 'handled') {
      if (value === '/skill create' || value.startsWith('/skill create ') || value === '/skills create' || value.startsWith('/skills create ') || value.startsWith('/skill remove ') || value.startsWith('/skills remove ')) {
        await refreshSkills().catch(() => undefined);
      }
      return;
    }

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
      setAbortController: controller => { abortControllerRef.current = controller; },
    });
  }

  const visible = messages.filter(message => !message.hidden);
  const placeholder = mode === 'apiKey' ? 'OpenRouter API key' : mode === 'model' ? 'x-ai/grok-build-0.1' : busy ? 'Thinking, allegedly' : 'Ask Haze to help build your app';
  const activeModelName = process.env.HAZE_MODEL ?? settings.model ?? 'x-ai/grok-build-0.1';
  const hasLogin = Boolean(process.env.OPENAI_API_KEY ?? settings.apiKey);
  const hasChosenModel = Boolean(process.env.HAZE_MODEL ?? settings.model);
  const headerSubtitle = hasLogin && hasChosenModel
    ? [
      'A minimal LLM harness for growing your own workflows while you work.',
      '',
      'Start with simple chat, then teach Haze your habits with skills:',
      '/skill create review my branch against main  — tiny spell, useful goblin.',
      '',
      'The most adaptive workflow is the one you shape as you go.',
      '',
      'Guardrails are light: Haze lets the LLM work from the terminal almost like you,',
      'while trying to stay scoped to this project.',
    ].join('\n')
    : 'First things first: run /login to add your API key, then /model x-ai/grok-build-0.1 to choose a model.';
  const workspaceLabel = `${process.cwd()}${branchName ? ` (${branchName})` : ''}`;
  const toolsUsed = toolCallCount(messages);
  const estimatedTokens = estimateConversationTokens(messages);
  const statusDetailLabel = `${conversationRef.current.length} messages / ${toolsUsed} tool call${toolsUsed === 1 ? '' : 's'} / ↑ ~${formatTokenCount(estimatedTokens.input)} ↓ ~${formatTokenCount(estimatedTokens.output)} / ${skills.length} skill${skills.length === 1 ? '' : 's'}`;
  const slashSuggestions: TextInputSuggestion[] = mode === 'chat' ? [
    {value: '/help', description: 'Show commands', kind: 'command'},
    {value: '/login', description: 'Save an OpenRouter API key', kind: 'command'},
    {value: '/model', description: 'Choose a model', kind: 'command'},
    {value: '/settings', description: 'Show provider, model, API key, and context status', kind: 'command'},
    {value: '/skill create ', description: 'Create a Markdown skill', kind: 'command'},
    {value: '/skill list', description: 'List installed skills', kind: 'command'},
    {value: '/skill info ', description: 'Show details for a skill', kind: 'command'},
    {value: '/skill validate ', description: 'Validate a skill', kind: 'command'},
    {value: '/skill remove ', description: 'Remove a skill with --yes', kind: 'command'},
    {value: '/init', description: 'Create or update AGENTS.md project instructions', kind: 'command'},
    {value: '/clear', description: 'Clear conversation history', kind: 'command'},
    {value: '/exit', description: 'Exit Haze', kind: 'command'},
    {value: '/quit', description: 'Exit Haze', kind: 'command'},
    ...skills.map(skill => ({value: `/${skill.name}`, description: skill.description, kind: 'skill' as const})),
  ] : [];

  return <Box flexDirection="column" minHeight={height}>
    <Box flexShrink={0}>
      <Header subtitle={headerSubtitle} version={version} />
    </Box>
    <Box flexDirection="column" flexGrow={1}>
      {visible.map((message, index) => <Box key={index} flexDirection="column" marginBottom={1}>
        <Text color={message.role === 'user' ? theme.purple : message.role === 'assistant' ? theme.success : message.role === 'tool' ? theme.blue : theme.muted} bold>
          {message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Haze' : message.role === 'tool' ? 'Tool' : 'Info'}
        </Text>
        {message.role === 'tool'
          ? <ToolMessageText text={message.text} streaming={message.streaming} />
          : message.role === 'assistant' && !message.streaming
            ? <MarkdownText content={message.text} />
            : <Text>{message.text}</Text>}
      </Box>)}
    </Box>
    {debug && debugLogs.length > 0 && <Box flexDirection="column" flexShrink={0} marginBottom={1} borderStyle="round" borderColor={theme.muted} paddingX={1}>
      <Text color={theme.muted} bold>Debug</Text>
      {debugLogs.map((line, index) => <Text key={index} color={theme.muted}>• {line}</Text>)}
    </Box>}
    {busy && <Box flexShrink={0} marginBottom={1}>
      <Text color={theme.muted}><Spinner type="dots" /> {busyLabel}<Text dimColor> · esc to interrupt</Text></Text>
    </Box>}
    <Box borderStyle="round" borderColor={theme.deepPurple} paddingX={1} flexShrink={0}>
      <Box flexGrow={1} minWidth={0}>
        <TextInput
          placeholder={placeholder}
          disabled={busy}
          mask={mode === 'apiKey'}
          historyItems={inputHistory}
          recordHistory={mode === 'chat'}
          suggestions={slashSuggestions}
          onHistoryAdd={persistInputHistory}
          onCancel={cancelThinking}
          onSubmit={submit}
        />
      </Box>
    </Box>
    <Box flexShrink={0} justifyContent="space-between">
      <Box flexDirection="column" flexShrink={1} minWidth={0}>
        <Text color={theme.muted} dimColor wrap="truncate-end">{workspaceLabel}</Text>
        <Text color={theme.muted} dimColor wrap="truncate-end">{statusDetailLabel}</Text>
      </Box>
      <Box flexShrink={0} marginLeft={2}>
        <Text color={theme.muted} dimColor wrap="truncate-start">{activeModelName}</Text>
      </Box>
    </Box>
  </Box>;
}

export async function chatCommand(options: ChatOptions = {}) {
  const app = render(<ChatScreen debug={options.debug} />);
  await app.waitUntilExit();
}
