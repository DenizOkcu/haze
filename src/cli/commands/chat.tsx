import React, {useEffect, useRef, useState} from 'react';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {Box, render, Static, Text, useApp, useStdout} from 'ink';
import Spinner from 'ink-spinner';
import {type ModelMessage} from 'ai';
import {readContextFiles, type ContextFile} from '../../config/contextFiles.js';
import {addInputHistoryItem, readInputHistory} from '../../config/inputHistory.js';
import {readSettings, updateSettings, type HazeProviderSettings, type HazeSettings} from '../../config/settings.js';
import {activeModel, configuredProviders, DEFAULT_PROVIDER_NAME, findProvider, modelSelector, providerHasKey, resolveModelSelector, upsertProvider} from '../../config/providers.js';
import {Header} from '../../ui/components/Header.js';
import {TextInput, type TextInputSuggestion} from '../../ui/components/TextInput.js';
import {MarkdownText} from '../../ui/components/MarkdownText.js';
import {theme} from '../../ui/theme.js';
import {handleSlashCommand, type CommandContext} from './commands.js';
import {runAgentTurn, type Message} from './streaming.js';
import {loadSkillRegistry} from '../../skills/SkillRegistry.js';
import type {LoadedSkill} from '../../skills/types.js';
import {appendSessionEntry, createSession, formatSession, latestSession, restoreConversation, type HazeSession} from '../../core/session/sessionStore.js';
import {compactModelMessages, modelMessageText} from '../../core/agent/compaction.js';
import {createSessionGoal, formatGoalStatus} from '../../core/goal/sessionGoal.js';

export type Mode = 'chat' | 'provider' | 'providerAction' | 'model' | 'providerAddName' | 'providerAddUrl' | 'providerAddKey' | 'providerAddModels' | 'providerAppendModels';

interface ChatOptions {
  debug?: boolean;
  version?: string;
  continueSession?: boolean;
  noSession?: boolean;
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

function truncateWithEllipsis(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}…`;
}

function displayMessagesFromConversation(conversation: ModelMessage[]): Message[] {
  return conversation.flatMap(message => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const text = modelMessageText(message).trim();
    return text ? [{role: message.role, text} satisfies Message] : [];
  });
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

function fullWidthLines(text: string, width: number, leftPadding = 0) {
  const safeWidth = Math.max(1, width);
  const prefix = ' '.repeat(leftPadding);
  return text.replace(/\r\n|\r/g, '\n').split('\n').map(line => `${prefix}${line}`.padEnd(Math.max(safeWidth, line.length + leftPadding)));
}

function fullWidthBlankLine(width: number) {
  return ''.padEnd(Math.max(1, width));
}

function ToolMessageText({text, streaming}: {text: string; streaming?: boolean}) {
  const lines = text.split('\n');
  return <Box flexDirection="column">
    {lines.map((line, index) => {
      const diffRow = /^(\s*\d+\s+)([+-])(.*)$/.exec(line);
      if (diffRow) {
        const [, prefix, marker, rest] = diffRow;
        const isAdd = marker === '+';
        return <Text key={`${index}-${line}`} color="white" backgroundColor={isAdd ? theme.successBg : theme.dangerBg}>
          <Text color={isAdd ? theme.success : theme.danger} backgroundColor={isAdd ? theme.successBg : theme.dangerBg}>{prefix}{marker}</Text>{rest}
        </Text>;
      }
      const contextRow = /^(\s*\d+\s+)\s(.*)$/.exec(line);
      if (contextRow) {
        const [, prefix, rest] = contextRow;
        return <Text key={`${index}-${line}`} color="white">
          <Text color={theme.muted}>{prefix} </Text>{rest}
        </Text>;
      }
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

function MessageView({message, width}: {message: Message; width: number}) {
  if (message.role === 'user') {
    return <Box flexDirection="column" marginBottom={1}>
      <Text backgroundColor={theme.quoteBg}>{fullWidthBlankLine(width)}</Text>
      <Text color={theme.success} bold backgroundColor={theme.quoteBg}>{'  You asked'.padEnd(width)}</Text>
      {fullWidthLines(message.text, width, 2).map((line, lineIndex) => <Text key={lineIndex} color="white" backgroundColor={theme.quoteBg}>{line}</Text>)}
      <Text backgroundColor={theme.quoteBg}>{fullWidthBlankLine(width)}</Text>
    </Box>;
  }

  return <Box flexDirection="column" marginBottom={1}>
    <Text color={message.role === 'assistant' ? theme.purple : message.role === 'tool' ? theme.blue : theme.muted} bold>
      {message.role === 'assistant' ? 'haze' : message.role === 'tool' ? 'Tool' : 'Info'}
    </Text>
    {message.role === 'tool'
      ? <ToolMessageText text={message.text} streaming={message.streaming} />
      : message.role === 'assistant' && !message.streaming
        ? <MarkdownText content={message.text} />
        : <Text>{message.text}</Text>}
  </Box>;
}

function messageKey(message: Message, index: number) {
  return message.id ?? `${index}-${message.role}-${message.text}`;
}

function startupProviderInfo(settings: HazeSettings) {
  const selection = activeModel(settings);
  const model = process.env.HAZE_MODEL ?? selection.model;
  const modelSource = process.env.HAZE_MODEL ? 'HAZE_MODEL env' : settings.model ? 'settings' : 'provider default';
  const baseURL = process.env.OPENAI_BASE_URL ?? selection.provider.url;
  const baseURLSource = process.env.OPENAI_BASE_URL ? 'OPENAI_BASE_URL env' : 'settings';
  const apiKeySource = process.env.OPENAI_API_KEY ? 'OPENAI_API_KEY env' : providerHasKey(settings, selection.provider) ? `provider ${selection.provider.name}` : 'missing';
  const provider = process.env.OPENAI_BASE_URL ? 'OpenAI-compatible custom endpoint' : selection.provider.name;

  return [
    'Provider configuration',
    `- Provider: ${provider}`,
    `- Model: ${model} (${modelSource})`,
    `- Base URL: ${baseURL} (${baseURLSource})`,
    `- API key: ${apiKeySource === 'missing' ? 'not configured; local providers may not need one' : `configured via ${apiKeySource}`}`,
    `- Configured providers: ${configuredProviders(settings).length}`,
  ].join('\n');
}

function ChatScreen({debug = false, version, continueSession = false, noSession = false}: ChatOptions) {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const width = stdout.columns ?? process.stdout.columns ?? 80;
  const [messages, setMessages] = useState<Message[]>([
    {role: 'system', text: 'Welcome to Haze. Use /help for commands.'}
  ]);
  const [liveMessages, setLiveMessages] = useState<Message[]>([]);
  const liveMessagesRef = useRef<Message[]>([]);
  const setLiveMessagesState = (updater: (messages: Message[]) => Message[]) => {
    setLiveMessages(previous => {
      const next = updater(previous);
      liveMessagesRef.current = next;
      return next;
    });
  };
  const [settings, setSettings] = useState<HazeSettings>({});
  const conversationRef = useRef<ModelMessage[]>([]);
  const lastAssistantTextRef = useRef('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<HazeSession | undefined>(undefined);
  const followUpQueueRef = useRef<string[]>([]);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  const [mode, setMode] = useState<Mode>('chat');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('Haze is thinking');
  const [activeGoalStatus, setActiveGoalStatus] = useState<string | undefined>();
  const [sessionLabel, setSessionLabel] = useState<string | undefined>();
  const [queuedFollowUps, setQueuedFollowUps] = useState<string[]>([]);
  const [skills, setSkills] = useState<LoadedSkill[]>([]);
  const [branchName, setBranchName] = useState<string | undefined>();
  const [modelProviderFilter, setModelProviderFilter] = useState<string | undefined>();
  const [selectedProviderName, setSelectedProviderName] = useState<string | undefined>();
  const [providerDraft, setProviderDraft] = useState<Partial<HazeProviderSettings>>({});

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
    initializeSession().catch(error => {
      const text = error instanceof Error ? error.message : String(error);
      setMessages(m => [...m, {role: 'system', text: `Session disabled: ${text}`}]);
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
    const [name, ...args] = value.slice(1).trim().split(/\s+/).filter(Boolean);
    if (!name) return undefined;
    const skill = skills.find(candidate => candidate.name === name);
    return skill ? {skill, args: args.join(' ')} : undefined;
  }

  function debugLog(line: string) {
    if (!debug) return;
    setDebugLogs(current => [...current.slice(-7), line]);
  }

  async function startNewSession(message = 'Started a new session.') {
    if (noSession) {
      sessionRef.current = undefined;
      setSessionLabel('session off');
      return;
    }
    const session = await createSession({hazeVersion: version});
    sessionRef.current = session;
    setSessionLabel(session.id);
    setMessages(m => [...m, {role: 'system', text: `${message}\nSession saved: ${session.file}`}]);
  }

  async function initializeSession() {
    if (noSession) {
      setSessionLabel('session off');
      return;
    }
    if (continueSession) {
      const session = await latestSession();
      if (session) {
        const conversation = await restoreConversation(session);
        sessionRef.current = session;
        conversationRef.current = conversation;
        setSessionLabel(session.id);
        setLiveMessagesState(() => []);
        setMessages(m => [...m, {role: 'system', text: `Resumed session: ${formatSession(session)}`}, ...displayMessagesFromConversation(conversation)]);
        return;
      }
    }
    await startNewSession(continueSession ? 'No previous session found. Started a new session.' : 'Started a new session.');
  }

  function clearConversation() {
    conversationRef.current = [];
    lastAssistantTextRef.current = '';
    setLiveMessagesState(() => []);
    setMessages([{role: 'system', text: 'Cleared. The void is productive.'}]);
    const session = sessionRef.current;
    if (session) void appendSessionEntry(session, {type: 'event', at: new Date().toISOString(), name: 'clear', text: 'Conversation cleared'}).catch(() => undefined);
  }

  function compactConversation(instructions?: string) {
    const result = compactModelMessages(conversationRef.current, {instructions});
    if (!result.compacted) {
      setMessages(m => [...m, {role: 'system', text: `Compaction skipped: only ${result.keptCount} model messages in context.`}]);
      return false;
    }
    conversationRef.current = result.messages;
    const session = sessionRef.current;
    if (session) {
      void appendSessionEntry(session, {type: 'event', at: new Date().toISOString(), name: 'compact', text: `Compacted ${result.olderCount} messages; kept ${result.keptCount}.`}).catch(() => undefined);
      void appendSessionEntry(session, {type: 'conversation_snapshot', at: new Date().toISOString(), messages: result.messages}).catch(() => undefined);
    }
    setMessages(m => [...m, {role: 'system', text: `Compacted context: summarized ${result.olderCount} older model messages and kept the last ${result.keptCount}.`}]);
    return true;
  }

  async function resumeLatestSession() {
    const session = await latestSession();
    if (!session) {
      setMessages(m => [...m, {role: 'system', text: 'No previous session found for this workspace.'}]);
      return;
    }
    const conversation = await restoreConversation(session);
    sessionRef.current = session;
    conversationRef.current = conversation;
    setSessionLabel(session.id);
    setLiveMessagesState(() => []);
    setMessages([{role: 'system', text: `Resumed session: ${formatSession(session)}`}, ...displayMessagesFromConversation(conversation)]);
  }

  function cancelThinking() {
    if (!busy) return;
    abortControllerRef.current?.abort('User pressed Esc.');
    if (followUpQueueRef.current.length > 0) {
      followUpQueueRef.current = [];
      setQueuedFollowUps([]);
      setMessages(m => [...m, {role: 'system', text: 'Cleared queued follow-ups after interrupt.'}]);
    }
    setBusy(false);
  }

  function queueFollowUp(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    followUpQueueRef.current = [...followUpQueueRef.current, trimmed];
    setQueuedFollowUps(followUpQueueRef.current);
    setMessages(m => [...m, {role: 'system', text: `Queued follow-up (${followUpQueueRef.current.length}): ${trimmed}`}]);
  }

  function closeInputList() {
    if (mode === 'provider' || mode === 'providerAction' || mode === 'model') {
      setMode('chat');
      setModelProviderFilter(undefined);
      setSelectedProviderName(undefined);
    }
  }

  function providerSuggestions(): TextInputSuggestion[] {
    return [
      ...configuredProviders(settings).map(provider => ({
        value: provider.name,
        description: `${provider.url} · ${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`,
        kind: 'provider' as const,
      })),
      {value: 'add provider', description: 'Add a new OpenAI-compatible provider', kind: 'provider' as const},
    ];
  }

  function providerActionSuggestions(): TextInputSuggestion[] {
    return [
      {value: 'use provider', description: 'Set this provider and choose a model', kind: 'provider' as const},
      {value: 'add models', description: 'Append comma-separated model names to this provider', kind: 'provider' as const},
    ];
  }

  function modelSuggestions(): TextInputSuggestion[] {
    const providers = configuredProviders(settings).filter(provider => !modelProviderFilter || provider.name === modelProviderFilter);
    return providers.flatMap(provider => provider.models.map(model => ({
      value: modelProviderFilter ? model : modelSelector(provider, model),
      description: provider.name,
      kind: 'model' as const,
    })));
  }

  async function selectProvider(providerName: string) {
    if (providerName === 'add provider') {
      setProviderDraft({});
      setMode('providerAddName');
      setMessages(m => [...m, {role: 'system', text: 'Provider name? Example: openrouter, local, lmstudio.'}]);
      return;
    }
    const provider = findProvider(settings, providerName);
    if (!provider) {
      setMessages(m => [...m, {role: 'system', text: `No provider named ${providerName}. Use /provider and choose add provider.`}]);
      setMode('chat');
      return;
    }
    setSelectedProviderName(provider.name);
    setMode('providerAction');
    setMessages(m => [...m, {role: 'system', text: `${provider.name}: choose an action.`}]);
  }

  async function useProvider(providerName: string) {
    const provider = findProvider(settings, providerName);
    if (!provider) {
      setMessages(m => [...m, {role: 'system', text: `No provider named ${providerName}.`}]);
      setMode('chat');
      setSelectedProviderName(undefined);
      return;
    }
    const next = await updateSettings({provider: provider.name});
    setSettings(next);
    setSelectedProviderName(undefined);
    setModelProviderFilter(provider.name);
    setMode('model');
    setMessages(m => [...m, {role: 'system', text: `Provider set to ${provider.name}. Choose a model.`}]);
  }

  async function selectProviderAction(action: string) {
    if (!selectedProviderName) {
      setMode('provider');
      return;
    }
    if (action === 'use provider') {
      await useProvider(selectedProviderName);
      return;
    }
    if (action === 'add models') {
      setMode('providerAppendModels');
      setMessages(m => [...m, {role: 'system', text: `Comma-separated model names to add to ${selectedProviderName}?`}]);
      return;
    }
    setMessages(m => [...m, {role: 'system', text: `Unknown provider action: ${action}`}]);
  }

  async function selectModel(selector: string) {
    const scopedSelector = modelProviderFilter ? `${modelProviderFilter}:${selector}` : selector;
    const resolved = resolveModelSelector(settings, scopedSelector);
    if (resolved.status === 'ambiguous') {
      setMessages(m => [...m, {role: 'system', text: `Model ${resolved.model} exists on multiple providers: ${resolved.providers.map(provider => modelSelector(provider, resolved.model)).join(', ')}`}]);
      return;
    }
    if (resolved.status === 'missing') {
      setMessages(m => [...m, {role: 'system', text: `No configured model named ${selector}. Use /provider, select a provider, then choose add models.`}]);
      return;
    }
    const next = await updateSettings({provider: resolved.provider.name, model: resolved.model});
    setSettings(next);
    setModelProviderFilter(undefined);
    setMode('chat');
    setMessages(m => [...m, {role: 'system', text: `Model set to ${resolved.model} on ${resolved.provider.name}.\n\n${startupProviderInfo(next)}`}]);
  }

  async function appendModelsToProvider(modelsValue: string) {
    const provider = selectedProviderName ? findProvider(settings, selectedProviderName) : undefined;
    const models = modelsValue.split(',').map(model => model.trim()).filter(Boolean);
    if (!provider) {
      setMessages(m => [...m, {role: 'system', text: 'No provider selected.'}]);
      setMode('chat');
      return;
    }
    if (models.length === 0) {
      setMessages(m => [...m, {role: 'system', text: 'Enter at least one model name.'}]);
      return;
    }
    const nextProvider = {...provider, models: [...new Set([...provider.models, ...models])]};
    const next = await updateSettings({providers: upsertProvider(settings, nextProvider), provider: provider.name});
    setSettings(next);
    setSelectedProviderName(undefined);
    setModelProviderFilter(provider.name);
    setMode('model');
    setMessages(m => [...m, {role: 'system', text: `Added ${models.length} model${models.length === 1 ? '' : 's'} to ${provider.name}. Choose a model.`}]);
  }

  async function finishProviderAdd(modelsValue: string) {
    const models = modelsValue.split(',').map(model => model.trim()).filter(Boolean);
    if (!providerDraft.name || !providerDraft.url || models.length === 0) {
      setMessages(m => [...m, {role: 'system', text: 'Provider name, URL, and at least one model are required.'}]);
      setMode('chat');
      setProviderDraft({});
      return;
    }
    const provider: HazeProviderSettings = {
      name: providerDraft.name,
      url: providerDraft.url,
      ...(providerDraft.key ? {key: providerDraft.key} : {}),
      models: [...new Set(models)],
    };
    const next = await updateSettings({providers: upsertProvider(settings, provider), provider: provider.name});
    setSettings(next);
    setProviderDraft({});
    setModelProviderFilter(provider.name);
    setMode('model');
    setMessages(m => [...m, {role: 'system', text: `Added provider ${provider.name}. Choose a model.`}]);
  }

  async function submit(value: string) {
    if (busy) {
      if (mode === 'chat') queueFollowUp(value);
      return;
    }

    if (mode === 'provider') {
      await selectProvider(value);
      return;
    }

    if (mode === 'providerAction') {
      await selectProviderAction(value);
      return;
    }

    if (mode === 'model') {
      await selectModel(value);
      return;
    }

    if (mode === 'providerAddName') {
      const name = value.trim();
      if (!name) {
        setMessages(m => [...m, {role: 'system', text: 'Provider name is required.'}]);
        return;
      }
      if (settings.providers?.some(provider => provider.name === name)) {
        setMessages(m => [...m, {role: 'system', text: `Provider ${name} already exists. Choose a unique name.`}]);
        return;
      }
      setProviderDraft({name});
      setMode('providerAddUrl');
      setMessages(m => [...m, {role: 'system', text: 'OpenAI-compatible base URL? Example: https://openrouter.ai/api/v1 or http://localhost:1234/v1'}]);
      return;
    }

    if (mode === 'providerAddUrl') {
      try {
        new URL(value);
      } catch {
        setMessages(m => [...m, {role: 'system', text: 'Enter a valid URL, for example http://localhost:1234/v1.'}]);
        return;
      }
      setProviderDraft(draft => ({...draft, url: value.trim()}));
      setMode('providerAddKey');
      setMessages(m => [...m, {role: 'system', text: 'API key? Leave blank for local/keyless providers.'}]);
      return;
    }

    if (mode === 'providerAddKey') {
      setProviderDraft(draft => ({...draft, ...(value.trim() ? {key: value.trim()} : {})}));
      setMode('providerAddModels');
      setMessages(m => [...m, {role: 'system', text: 'Comma-separated model names? Example: llama3.1, qwen2.5-coder, gpt-4o'}]);
      return;
    }

    if (mode === 'providerAddModels') {
      await finishProviderAdd(value);
      return;
    }

    if (mode === 'providerAppendModels') {
      await appendModelsToProvider(value);
      return;
    }

    const invokedSkill = skillInvocation(value);
    if (invokedSkill) {
      const argumentText = invokedSkill.args ? `\nUser-provided skill arguments: ${invokedSkill.args}` : '';
      await doAgentTurn(`The user explicitly invoked the "${invokedSkill.skill.name}" skill. Call skill_${invokedSkill.skill.name.replace(/[^a-zA-Z0-9_]/g, '_')} and follow its returned instructions.${argumentText}`, value);
      return;
    }

    const isSkillCreate = /^\/create-skill(?:\s|$)/.test(value) || /^\/skills? create(?:\s|$)/.test(value);
    const skillCreateGoal = isSkillCreate ? createSessionGoal(value) : undefined;
    if (skillCreateGoal) {
      setDebugLogs([]);
      setMessages(m => [...m, {role: 'user', text: value}]);
      const session = sessionRef.current;
      if (session) void appendSessionEntry(session, {type: 'ui_message', at: new Date().toISOString(), role: 'user', text: value}).catch(() => undefined);
      setActiveGoalStatus(formatGoalStatus(skillCreateGoal));
    }

    const ctx: CommandContext = {
      settings,
      contextFiles,
      setMode,
      setModelProviderFilter,
      addSystemMessage: text => setMessages(m => [...m, {role: 'system', text}]),
      clearConversation,
      newSession: async () => {
        conversationRef.current = [];
        lastAssistantTextRef.current = '';
        setLiveMessagesState(() => []);
        setMessages([{role: 'system', text: 'Started fresh. The fog parts.'}]);
        await startNewSession('Started a new session.');
      },
      resumeSession: resumeLatestSession,
      sessionInfo: () => sessionRef.current ? formatSession(sessionRef.current) : 'Session persistence is off.',
      compactConversation,
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
      if (skillCreateGoal) {
        skillCreateGoal.status = 'blocked';
        skillCreateGoal.blocker = error instanceof Error ? error.message : String(error);
        setActiveGoalStatus(formatGoalStatus(skillCreateGoal));
      }
      const text = error instanceof Error ? error.message : String(error);
      setMessages(m => [...m, {role: 'system', text: `Skill creation failed: ${text}`}]);
      return;
    } finally {
      if (isSkillCreate) {
        if (skillCreateGoal?.status === 'active') {
          skillCreateGoal.phase = 'done';
          skillCreateGoal.status = 'complete';
          setActiveGoalStatus(undefined);
        }
        setBusy(false);
        setBusyLabel('Haze is thinking');
      }
    }
    if (result === 'exit') return exit();
    if (result === 'handled') {
      if (value === '/create-skill' || value.startsWith('/create-skill ') || value === '/skill create' || value.startsWith('/skill create ') || value === '/skills create' || value.startsWith('/skills create ') || value.startsWith('/remove-skill ') || value.startsWith('/skill remove ') || value.startsWith('/skills remove ')) {
        await refreshSkills().catch(() => undefined);
      }
      return;
    }

    await doAgentTurn(value);
  }

  async function doAgentTurn(value: string, displayValue?: string) {
    setDebugLogs([]);
    await runSingleAgentTurn(value, displayValue);
    while (followUpQueueRef.current.length > 0) {
      const next = followUpQueueRef.current[0];
      followUpQueueRef.current = followUpQueueRef.current.slice(1);
      setQueuedFollowUps(followUpQueueRef.current);
      setMessages(m => [...m, {role: 'system', text: `Running queued follow-up: ${next}`}]);
      await runSingleAgentTurn(next);
    }
  }

  async function runSingleAgentTurn(value: string, displayValue?: string) {
    const persistUiMessage = (msg: Message) => {
      const session = sessionRef.current;
      if (session) void appendSessionEntry(session, {type: 'ui_message', at: new Date().toISOString(), role: msg.role, text: msg.text}).catch(() => undefined);
    };
    const finalizeMessage = (msg: Message) => {
      if (msg.hidden) return;
      setMessages(m => [...m, msg]);
      persistUiMessage(msg);
    };

    await runAgentTurn(value, displayValue, contextFiles, {
      addMessage: msg => {
        if (msg.streaming) {
          setLiveMessagesState(m => [...m, msg]);
          return;
        }
        finalizeMessage(msg);
      },
      updateMessage: (id, update) => {
        const liveMessage = liveMessagesRef.current.find(msg => msg.id === id);
        if (liveMessage) {
          const updated = {...liveMessage, ...update};
          if (updated.streaming === false) {
            setLiveMessagesState(m => m.filter(msg => msg.id !== id));
            finalizeMessage(updated);
            return;
          }
          setLiveMessagesState(m => m.map(msg => msg.id === id ? {...msg, ...update} : msg));
          return;
        }
        setMessages(m => m.map(msg => msg.id === id ? {...msg, ...update} : msg));
      },
      setConversation: msgs => {
        conversationRef.current = msgs;
        const session = sessionRef.current;
        if (session) void appendSessionEntry(session, {type: 'conversation_snapshot', at: new Date().toISOString(), messages: msgs}).catch(() => undefined);
      },
      setBusy,
      setBusyLabel,
      debugLog,
      getConversation: () => conversationRef.current,
      getLastAssistantText: () => lastAssistantTextRef.current,
      setLastAssistantText: text => { lastAssistantTextRef.current = text; },
      setAbortController: controller => { abortControllerRef.current = controller; },
      setGoalStatus: setActiveGoalStatus,
      compactConversation,
      onEvent: event => {
        const session = sessionRef.current;
        if (session) void appendSessionEntry(session, {type: 'event', at: event.at, name: event.type, text: JSON.stringify(event)}).catch(() => undefined);
      },
    });
  }

  const visible = messages.filter(message => !message.hidden);
  const transcriptItems = visible.map((message, index) => ({key: messageKey(message, index), message}));
  const activeLiveMessages = liveMessages.filter(message => !message.hidden);
  const activeSelection = activeModel(settings);
  const placeholder = mode === 'provider'
    ? 'Choose provider'
    : mode === 'providerAction'
      ? 'Choose provider action'
      : mode === 'model'
        ? 'Choose model'
        : mode === 'providerAddName'
          ? 'Provider name'
          : mode === 'providerAddUrl'
            ? 'https://example.com/v1'
            : mode === 'providerAddKey'
              ? 'API key, or blank for local'
              : mode === 'providerAddModels' || mode === 'providerAppendModels'
                ? 'model-a, model-b'
                : busy ? 'Queue a follow-up, or Esc to interrupt' : 'Ask Haze to help build your app';
  const activeModelName = `${activeSelection.provider.name}:${process.env.HAZE_MODEL ?? activeSelection.model}`;
  const hasLogin = Boolean(process.env.OPENAI_API_KEY ?? settings.apiKey ?? activeSelection.provider.key) || activeSelection.provider.name !== DEFAULT_PROVIDER_NAME;
  const hasChosenModel = Boolean(process.env.HAZE_MODEL ?? settings.model ?? activeSelection.model);
  const headerSubtitle = hasLogin && hasChosenModel
    ? [
      'A minimal LLM harness for growing your own workflows while you work.',
      '',
      'Start with simple chat, then teach Haze your habits with skills:',
      '/create-skill review my branch against main  — tiny spell, useful goblin.',
      '',
      'The most adaptive workflow is the one you shape as you go.',
      '',
      'Guardrails are light: Haze lets the LLM work from the terminal almost like you,',
      'while trying to stay scoped to this project.',
    ].join('\n')
    : 'First things first: run /provider to choose or add a provider, then select a model.';
  const workspaceLabel = `${process.cwd()}${branchName ? ` (${branchName})` : ''}`;
  const allDisplayMessages = [...messages, ...liveMessages];
  const toolsUsed = toolCallCount(allDisplayMessages);
  const estimatedTokens = estimateConversationTokens(allDisplayMessages);
  const statusDetailLabel = `${conversationRef.current.length} messages / ${toolsUsed} tool call${toolsUsed === 1 ? '' : 's'} / ↑ ~${formatTokenCount(estimatedTokens.input)} ↓ ~${formatTokenCount(estimatedTokens.output)} / ${skills.length} skill${skills.length === 1 ? '' : 's'}${sessionLabel ? ` / ${sessionLabel}` : ''}`;
  const goalText = activeGoalStatus?.replace(/^Goal:\s*/, '');
  const [rawGoalRequest, ...goalStatusParts] = goalText?.split(' · ') ?? [];
  const goalRequest = truncateWithEllipsis(rawGoalRequest ?? '', 120);
  const goalStatusText = goalStatusParts.join(' · ');
  const inputSuggestions: TextInputSuggestion[] = mode === 'provider' ? providerSuggestions() : mode === 'providerAction' ? providerActionSuggestions() : mode === 'model' ? modelSuggestions() : mode === 'chat' ? [
    {value: '/help', description: 'Show commands', kind: 'command'},
    {value: '/provider', description: 'Choose a provider', kind: 'command'},
    {value: '/model', description: 'Choose a model', kind: 'command'},
    {value: '/settings', description: 'Show provider, model, API key, and context status', kind: 'command'},
    {value: '/create-skill ', description: 'Create a Markdown skill', kind: 'command'},
    {value: '/list-skills', description: 'List installed skills', kind: 'command'},
    {value: '/skill-info ', description: 'Show details for a skill', kind: 'command'},
    {value: '/validate-skill ', description: 'Validate a skill', kind: 'command'},
    {value: '/remove-skill ', description: 'Remove a skill with --yes', kind: 'command'},
    {value: '/init', description: 'Create or update AGENTS.md project instructions', kind: 'command'},
    {value: '/session', description: 'Show current session path', kind: 'command'},
    {value: '/resume', description: 'Resume latest session for this workspace', kind: 'command'},
    {value: '/new', description: 'Start a new session', kind: 'command'},
    {value: '/compact ', description: 'Summarize older context and keep recent messages', kind: 'command'},
    {value: '/clear', description: 'Clear conversation history', kind: 'command'},
    {value: '/exit', description: 'Exit Haze', kind: 'command'},
    {value: '/quit', description: 'Exit Haze', kind: 'command'},
    ...skills.map(skill => ({value: `/${skill.name}`, description: skill.description, kind: 'skill' as const})),
  ] : [];
  const staticItems = [
    {kind: 'header' as const, key: `header-${activeModelName}-${hasLogin}-${hasChosenModel}`, subtitle: headerSubtitle},
    ...transcriptItems.map(item => ({kind: 'message' as const, ...item})),
  ];

  return <Box flexDirection="column">
    <Static items={staticItems}>
      {item => item.kind === 'header'
        ? <Header key={item.key} subtitle={item.subtitle} version={version} />
        : <MessageView key={item.key} message={item.message} width={width} />}
    </Static>
    {activeLiveMessages.length > 0 && <Box flexDirection="column" flexShrink={0}>
      {activeLiveMessages.map((message, index) => <MessageView key={messageKey(message, index)} message={message} width={width} />)}
    </Box>}
    {debug && debugLogs.length > 0 && <Box flexDirection="column" flexShrink={0} marginBottom={1} borderStyle="round" borderColor={theme.muted} paddingX={1}>
      <Text color={theme.muted} bold>Debug</Text>
      {debugLogs.map((line, index) => <Text key={index} color={theme.muted}>• {line}</Text>)}
    </Box>}
    {queuedFollowUps.length > 0 && <Box flexDirection="column" flexShrink={0} marginBottom={1}>
      <Text color={theme.muted}>Queued follow-ups:</Text>
      {queuedFollowUps.map((item, index) => <Text key={`${index}-${item}`} color={theme.muted} dimColor>  {index + 1}. {item}</Text>)}
    </Box>}
    {busy && <Box flexShrink={0} marginBottom={1}>
      <Text><Text color={theme.orange} bold><Spinner type="dots" /> {busyLabel}</Text><Text color={theme.muted} dimColor> · type to queue follow-up · esc to interrupt</Text></Text>
    </Box>}
    {goalText && <Box flexShrink={0}>
      <Text wrap="truncate-end"><Text color={theme.blue} bold>Goal:</Text><Text color="white"> {goalRequest}</Text>{goalStatusText ? <Text color={theme.orange}> · {goalStatusText}</Text> : null}</Text>
    </Box>}
    <Box borderStyle="round" borderColor={theme.deepPurple} paddingX={1} flexShrink={0}>
      <Box flexGrow={1} minWidth={0}>
        <TextInput
          placeholder={placeholder}
          disabled={busy && mode !== 'chat'}
          mask={mode === 'providerAddKey'}
          historyItems={inputHistory}
          recordHistory={mode === 'chat'}
          suggestions={inputSuggestions}
          suggestionMode={mode === 'provider' || mode === 'providerAction' || mode === 'model' ? 'always' : 'slash'}
          submitOnEmpty={mode === 'providerAddKey'}
          width={Math.max(20, width - 4)}
          onHistoryAdd={persistInputHistory}
          onCancel={cancelThinking}
          onEscape={() => {
            if (busy) cancelThinking();
            else closeInputList();
          }}
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
  if (process.stdout.isTTY) {
    process.stdout.write('\u001B[2J\u001B[3J\u001B[H');
  }
  const app = render(<ChatScreen debug={options.debug} version={options.version} continueSession={options.continueSession} noSession={options.noSession} />);
  await app.waitUntilExit();
}
