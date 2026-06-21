import React, {useEffect, useRef, useState} from 'react';
import {execFile as execFileCallback} from 'node:child_process';
import os from 'node:os';
import {promisify} from 'node:util';
import {Box, render, Static, Text, useApp, useStdout} from 'ink';
import Spinner from 'ink-spinner';
import {type ModelMessage} from 'ai';
import {readContextFiles, type ContextFile} from '../../config/contextFiles.js';
import {checkForUpdate} from '../../config/updateCheck.js';
import {addInputHistoryItem, readInputHistory} from '../../config/inputHistory.js';
import {loadTasks as loadTasksFromStore, clearTasks as clearTasksFromStore} from '../../core/tasks/taskStorage.js';
import type {Task, TaskStatus} from '../../core/tasks/taskStorage.js';
import {readSettings, updateSettings, type HazeMcpServer, type HazeProviderSettings, type HazeSettings} from '../../config/settings.js';
import {activeModel, configuredProviders, findProvider, modelSelector, providerHasKey, resolveModelSelector, upsertProvider} from '../../config/providers.js';
import {configuredLspServers, lspPreset, LSP_PRESETS, removeLspServer, setLspServerEnabled, upsertLspServer, type HazeLspServer} from '../../config/lspSettings.js';
import {configuredMcpServers, findMcpPreset, findMcpServer, presetIds, removeMcpServer, toggleMcpServer, upsertMcpServer} from '../../config/mcpSettings.js';
import {Header} from '../../ui/components/Header.js';
import {TextInput, type TextInputSuggestion} from '../../ui/components/TextInput.js';
import {MarkdownText} from '../../ui/components/MarkdownText.js';
import {theme} from '../../ui/theme.js';
import {handleSlashCommand, type CommandContext} from './commands.js';
import {runAgentTurn, type Message, type TokenUsage} from './streaming.js';
import {type LlmLog, createLog as createLlmLog, endLog as endLlmLog} from '../../core/log/llmLog.js';
import {formatElapsedTime, formatElapsedTimeWhole} from './formatters.js';
import {loadSkillRegistry} from '../../skills/SkillRegistry.js';
import {createSkill, toSkillDirName} from '../../skills/builder/SkillBuilder.js';
import {PROVIDER_PRESETS, findPreset} from '../../config/providerPresets.js';
import type {LoadedSkill} from '../../skills/types.js';
import {appendSessionEntry, createSession, formatSession, latestSession, restoreConversation, restoreWorkState, type HazeSession} from '../../core/session/sessionStore.js';
import {compactModelMessages, modelMessageText} from '../../core/agent/compaction.js';
import type {WorkState} from '../../core/agent/workState.js';
import {clearToolOutputs} from '../../core/agent/toolOutputStore.js';

export type Mode = 'chat' | 'provider' | 'providerAction' | 'model' | 'providerAddPreset' | 'providerAddName' | 'providerAddUrl' | 'providerAddKey' | 'providerAddModels' | 'providerAppendModels' | 'providerSetKey' | 'providerRemoveModels' | 'providerConfirmRemove' | 'skillCreateName' | 'skillCreateRole' | 'skillCreateDescription' | 'lsp' | 'lspAction' | 'lspAddPreset' | 'lspAddName' | 'lspAddCommand' | 'lspConfirmRemove' | 'mcp' | 'mcpAction' | 'mcpAddPreset' | 'mcpAddName' | 'mcpAddTransport' | 'mcpAddUrl' | 'mcpAddCommand' | 'mcpAddKey' | 'mcpSetKey' | 'mcpConfirmRemove';

/** Modes that show an always-on suggestion picker (server/preset lists). */
const PICKER_MODES: ReadonlySet<Mode> = new Set(['provider', 'providerAction', 'providerAddPreset', 'model', 'lsp', 'lspAction', 'lspAddPreset', 'mcp', 'mcpAction', 'mcpAddPreset', 'mcpAddTransport']);
/** Modes that mask input (secrets/API keys). */
const MASKED_MODES: ReadonlySet<Mode> = new Set(['providerAddKey', 'providerSetKey', 'mcpAddKey', 'mcpSetKey']);
/** Modes where submitting an empty value is valid (optional steps). */
const SUBMIT_EMPTY_MODES: ReadonlySet<Mode> = new Set(['providerAddKey', 'skillCreateRole', 'mcpAddKey']);

interface ChatOptions {
  debug?: boolean;
  version?: string;
  continueSession?: boolean;
  noSession?: boolean;
}

const execFile = promisify(execFileCallback);
const EMPTY_TOKEN_USAGE: TokenUsage = {inputTokens: undefined, outputTokens: undefined, systemPrompt: 0, messages: 0, toolSchemas: 0, outputEstimate: 0, cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 0, reasoningTokens: 0, logicalInputEstimate: 0, effectiveNonCachedInput: undefined};

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

function compactHomePath(filePath: string) {
  const home = os.homedir();
  if (filePath === home) return '~';
  return filePath.startsWith(`${home}/`) ? `~/${filePath.slice(home.length + 1)}` : filePath;
}

function formatTokenCount(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(tokens);
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
        const timer = /(.*) (\([0-9]+(?:h [0-9]+m [0-9]+(?:\.[0-9])?s|m [0-9]+(?:\.[0-9])?s|(?:\.[0-9])?s)\))$/.exec(line);
        return <Text key={`${index}-${line}`} color={theme.muted}>
          {index === 0 && streaming ? <><Spinner type="dots" /> </> : null}{timer ? timer[1] : line}{timer ? <Text color={theme.muted} bold={false}> {timer[2]}</Text> : null}
        </Text>;
      }
      const [, indent, icon, toolName, rest] = row;
      const iconColor = icon === '✓' ? theme.success : icon === '✗' ? theme.danger : theme.muted;
      const timer = /(.*) (\([0-9]+(?:h [0-9]+m [0-9]+(?:\.[0-9])?s|m [0-9]+(?:\.[0-9])?s|(?:\.[0-9])?s)\))$/.exec(rest);
      return <Text key={`${index}-${line}`} color={theme.muted}>
        {indent}<Text color={iconColor}>{icon}</Text> <Text color={theme.purple}>{toolName}</Text>{timer ? timer[1] : rest}{timer ? <Text color={theme.muted} bold={false}> {timer[2]}</Text> : null}
      </Text>;
    })}
  </Box>;
}

function messageElapsedLabel(message: Message) {
  if (message.startedAt == null) return '';
  const end = message.finishedAt ?? (message.streaming ? Date.now() : message.startedAt);
  const elapsed = end - message.startedAt;
  if (message.role === 'assistant' && !message.streaming && message.tokensPerSecond != null) {
    return `✓ Done in ${formatElapsedTime(elapsed)} · ${Math.round(message.tokensPerSecond)} tok/s`;
  }
  return message.streaming ? formatElapsedTimeWhole(elapsed) : formatElapsedTime(elapsed);
}

function MessageView({message, width, suppressAssistantHeader = false}: {message: Message; width: number; suppressAssistantHeader?: boolean}) {
  if (message.role === 'user') {
    return <Box flexDirection="column" marginBottom={1}>
      <Text backgroundColor={theme.quoteBg}>{fullWidthBlankLine(width)}</Text>
      <Text color={theme.success} bold backgroundColor={theme.quoteBg}>{'  You asked'.padEnd(width)}</Text>
      {fullWidthLines(message.text, width, 2).map((line, lineIndex) => <Text key={lineIndex} color="white" backgroundColor={theme.quoteBg}>{line}</Text>)}
      <Text backgroundColor={theme.quoteBg}>{fullWidthBlankLine(width)}</Text>
    </Box>;
  }

  return <Box flexDirection="column" marginBottom={1}>
    {!suppressAssistantHeader && <Text>
      <Text color={message.role === 'assistant' ? theme.purple : message.role === 'tool' ? theme.blue : theme.muted} bold>{message.role === 'assistant' ? 'haze' : message.role === 'tool' ? 'Tool' : 'Info'}</Text>
      {messageElapsedLabel(message) ? <Text color={theme.muted} bold={false}> · {messageElapsedLabel(message)}</Text> : null}
    </Text>}
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

function orderedDisplayMessages(messages: Message[]) {
  return messages
    .map((message, index) => ({message, index}))
    .sort((a, b) => {
      if (a.message.displayOrder != null && b.message.displayOrder != null && a.message.displayOrder !== b.message.displayOrder) {
        return a.message.displayOrder - b.message.displayOrder;
      }
      return a.index - b.index;
    })
    .map(item => item.message);
}

function annotateTurnHeaders(messages: Message[]) {
  return messages.map(message => ({message, suppressAssistantHeader: false}));
}

function startupProviderInfo(settings: HazeSettings) {
  const selection = activeModel(settings);
  const configuredCount = configuredProviders(settings).length;
  const lspServers = configuredLspServers(settings);
  const enabledLsp = lspServers.filter(server => server.enabled !== false);
  const lspLine = enabledLsp.length > 0
    ? `- LSP: ${enabledLsp.length} configured (${enabledLsp.map(server => server.name).join(', ')}; tools appear only when the command is installed)`
    : '- LSP: none configured (optional: install a language server, then /lsp presets and /lsp add typescript for semantic code navigation)';
  const mcpServers = configuredMcpServers(settings);
  const enabledMcp = mcpServers.filter(server => server.enabled !== false);
  const mcpLine = enabledMcp.length > 0
    ? `- MCP: ${enabledMcp.length} configured (${enabledMcp.map(server => server.name).join(', ')}; tools load each turn)`
    : '- MCP: none configured (optional: /mcp add context7 for up-to-date library docs)';
  if (!selection) {
    return [
      'Provider configuration',
      '- Provider: not configured',
      '- Model: not set',
      '- Base URL: not configured',
      '- API key: missing',
      `- Configured providers: ${configuredCount}`,
      lspLine,
      mcpLine,
      '',
      'Run /provider to choose or add a provider, then select a model.',
    ].join('\n');
  }
  const model = selection.model;
  const modelSource = settings.model ? 'settings' : 'provider default';
  const baseURL = selection.provider.url;
  const apiKeySource = providerHasKey(settings, selection.provider) ? `provider ${selection.provider.name}` : 'missing';
  const provider = selection.provider.name;

  return [
    'Provider configuration',
    `- Provider: ${provider}`,
    `- Model: ${model} (${modelSource})`,
    `- Base URL: ${baseURL} (settings)`,
    `- API key: ${apiKeySource === 'missing' ? 'not configured; local providers may not need one' : `configured via ${apiKeySource}`}`,
    `- Configured providers: ${configuredCount}`,
    lspLine,
    mcpLine,
  ].join('\n');
}

const TASK_STATUS_ICON: Record<TaskStatus, string> = {
  pending: '\u25CB',
  in_progress: '\u25D0',
  completed: '\u2713',
};

function taskStatusColor(status: TaskStatus): string {
  switch (status) {
    case 'completed': return theme.success;
    case 'in_progress': return theme.warning;
    default: return theme.muted;
  }
}

const MAX_VISIBLE_TASKS = 5;

function TaskBarContent({tasks, width, expanded, padding}: {tasks: Task[]; width: number; expanded: boolean; padding: number}) {
  const maxTitleWidth = Math.max(10, width - 6);
  const inProgress = tasks.filter(t => t.status === 'in_progress');
  const pending = tasks.filter(t => t.status === 'pending');
  const completed = tasks.filter(t => t.status === 'completed');
  const limit = expanded ? tasks.length : MAX_VISIBLE_TASKS;
  const ordered: Task[] = [];
  for (const t of inProgress) { if (ordered.length < limit) ordered.push(t); }
  for (const t of pending) { if (ordered.length < limit) ordered.push(t); }
  for (let i = completed.length - 1; i >= 0 && ordered.length < limit; i--) {
    ordered.push(completed[i]!);
  }
  const counts = `${inProgress.length > 0 ? `${inProgress.length} active` : ''}${pending.length > 0 ? `${inProgress.length > 0 ? ', ' : ''}${pending.length} pending` : ''}${completed.length > 0 ? `${inProgress.length + pending.length > 0 ? ', ' : ''}${completed.length} done` : ''}`;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {padding > 0 && Array.from({length: padding}, (_, i) => <Text key={`pad-${i}`}>{' '}</Text>)}
      <Text><Text color={theme.purple} bold>Tasks</Text>{counts ? <Text color={theme.muted}> ({counts})</Text> : null}{tasks.length > MAX_VISIBLE_TASKS ? <Text color={theme.muted} dimColor> · ctrl+o {expanded ? 'collapse' : 'expand'}</Text> : null}</Text>
      {ordered.map(task => {
        const title = task.title.length > maxTitleWidth ? task.title.slice(0, maxTitleWidth - 1) + '\u2026' : task.title;
        return (
          <Text key={task.id} wrap="truncate-end">
            <Text color={taskStatusColor(task.status)}>{TASK_STATUS_ICON[task.status]} </Text>
            <Text color={task.status === 'completed' ? theme.muted : 'white'}>{title}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function ChatScreen({debug = false, version, continueSession = false, noSession = false}: ChatOptions) {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const width = stdout.columns ?? process.stdout.columns ?? 80;
  const nextDisplayOrderRef = useRef(1);
  const withDisplayOrder = (message: Message): Message => {
    if (message.displayOrder != null) return message;
    return {...message, displayOrder: nextDisplayOrderRef.current++};
  };
  const withDisplayOrders = (next: Message[]) => next.map(withDisplayOrder);
  const [messages, setMessagesRaw] = useState<Message[]>([
    {role: 'system', text: 'Welcome to Haze. Use /help for commands.', displayOrder: 0}
  ]);
  const setMessages = (updater: React.SetStateAction<Message[]>) => {
    setMessagesRaw(previous => withDisplayOrders(typeof updater === 'function' ? updater(previous) : updater));
  };
  const [liveMessages, setLiveMessages] = useState<Message[]>([]);
  const liveMessagesRef = useRef<Message[]>([]);
  const setLiveMessagesState = (updater: (messages: Message[]) => Message[]) => {
    setLiveMessages(previous => {
      const next = withDisplayOrders(updater(previous));
      liveMessagesRef.current = next;
      return next;
    });
  };
  const [settings, setSettings] = useState<HazeSettings>({});
  const conversationRef = useRef<ModelMessage[]>([]);
  const lastAssistantTextRef = useRef('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<HazeSession | undefined>(undefined);
  const sessionStartRef = useRef<Date>(new Date());
  const workStateRef = useRef<WorkState | undefined>(undefined);
  const llmLogRef = useRef<LlmLog | undefined>(undefined);
  const followUpQueueRef = useRef<string[]>([]);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  const [mode, setMode] = useState<Mode>('chat');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('Haze is thinking');
  const [activeGoalStatus, setActiveGoalStatus] = useState<string | undefined>();
  const [visibleTasks, setVisibleTasks] = useState<Task[]>([]);
  const [tasksExpanded, setTasksExpanded] = useState(false);
  const [taskBarPadding, setTaskBarPadding] = useState(0);
  const [, setSessionLabel] = useState<string | undefined>();
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>({...EMPTY_TOKEN_USAGE});
  const [queuedFollowUps, setQueuedFollowUps] = useState<string[]>([]);
  const [skills, setSkills] = useState<LoadedSkill[]>([]);
  const [branchName, setBranchName] = useState<string | undefined>();
  const [modelProviderFilter, setModelProviderFilter] = useState<string | undefined>();
  const [selectedProviderName, setSelectedProviderName] = useState<string | undefined>();
  const [providerDraft, setProviderDraft] = useState<Partial<HazeProviderSettings>>({});
  const [skillCreateDraft, setSkillCreateDraft] = useState<{name?: string; role?: string}>({});
  const [selectedLspName, setSelectedLspName] = useState<string | undefined>();
  const [lspDraft, setLspDraft] = useState<Partial<HazeLspServer>>({});
  const [selectedMcpName, setSelectedMcpName] = useState<string | undefined>();
  const [mcpDraft, setMcpDraft] = useState<Partial<HazeMcpServer>>({});

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
    loadTasksFromStore().then(setVisibleTasks).catch(() => undefined);
    if (version) {
      checkForUpdate({currentVersion: version, packageName: '@denizokcu/haze'})
        .then(result => {
          if (result?.isOutdated) {
            setMessages(m => [...m, {role: 'system', text: `A new version of Haze is available: ${result.latestVersion} (you have ${version}). Update with:  npm i -g @denizokcu/haze`}]);
          }
        })
        .catch(() => undefined);
    }
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

  async function startNewLog() {
    if (!debug) return undefined;
    if (llmLogRef.current) {
      await endLlmLog(llmLogRef.current).catch(() => undefined);
    }
    const log = await createLlmLog();
    llmLogRef.current = log;
    return log;
  }

  async function startNewSession(message = 'Started a new session.') {
    clearToolOutputs();
    workStateRef.current = undefined;
    sessionStartRef.current = new Date();
    if (noSession) {
      sessionRef.current = undefined;
      setSessionLabel('session off');
      return;
    }
    const session = await createSession({hazeVersion: version});
    sessionRef.current = session;
    setTokenUsage({...EMPTY_TOKEN_USAGE});
    await startNewLog();
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
        sessionStartRef.current = new Date();
        conversationRef.current = conversation;
        setSessionLabel(session.id);
        setLiveMessagesState(() => []);
        const restoredMessages = displayMessagesFromConversation(conversation);
        setTokenUsage({...EMPTY_TOKEN_USAGE, messages: estimateConversationTokens(restoredMessages).input, outputEstimate: estimateConversationTokens(restoredMessages).output});
        workStateRef.current = await restoreWorkState(session);
        setMessages(m => [...m, {role: 'system', text: `Resumed session: ${formatSession(session)}`}, ...restoredMessages]);
        await startNewLog();
        return;
      }
    }
    await startNewSession(continueSession ? 'No previous session found. Started a new session.' : 'Started a new session.');
  }

  function clearConversation() {
    clearToolOutputs();
    conversationRef.current = [];
    lastAssistantTextRef.current = '';
    setTokenUsage({...EMPTY_TOKEN_USAGE});
    workStateRef.current = undefined;
    setLiveMessagesState(() => []);
    setMessages([{role: 'system', text: 'Cleared. The void is productive.'}]);
    void startNewLog();
    const session = sessionRef.current;
    if (session) void appendSessionEntry(session, {type: 'event', at: new Date().toISOString(), name: 'clear', text: 'Conversation cleared'}).catch(() => undefined);
  }

  function compactConversation(instructions?: string) {
    const result = compactModelMessages(conversationRef.current, {instructions, tokenBudget: 40_000, workState: workStateRef.current});
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
    clearToolOutputs();
    sessionRef.current = session;
    conversationRef.current = conversation;
    workStateRef.current = await restoreWorkState(session);
    setSessionLabel(session.id);
    setTokenUsage({...EMPTY_TOKEN_USAGE});
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
    if (mode !== 'chat') {
      setMode('chat');
      setModelProviderFilter(undefined);
      setSelectedProviderName(undefined);
      setProviderDraft({});
      setSkillCreateDraft({});
      setSelectedLspName(undefined);
      setLspDraft({});
      setSelectedMcpName(undefined);
      setMcpDraft({});
    }
  }

  function providerSuggestions(): TextInputSuggestion[] {
    return [
      ...configuredProviders(settings).map(provider => ({
        value: provider.name,
        description: `${provider.url} · ${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`,
        kind: 'provider' as const,
      })),
      {value: 'add provider', description: 'Add a new provider (presets available)', kind: 'provider' as const},
    ];
  }

  function providerActionSuggestions(): TextInputSuggestion[] {
    const provider = selectedProviderName ? findProvider(settings, selectedProviderName) : undefined;
    return [
      {value: 'use provider', description: 'Set this provider and choose a model', kind: 'provider' as const},
      {value: 'add models', description: 'Append comma-separated model names', kind: 'provider' as const},
      {value: 'set API key', description: provider?.key ? 'Update the saved API key' : 'Add an API key', kind: 'provider' as const},
      ...(provider?.models?.length ? [{value: 'remove models', description: 'Remove models from this provider', kind: 'provider' as const}] : []),
      {value: 'remove provider', description: 'Delete this provider from settings', kind: 'provider' as const},
    ];
  }

  function presetSuggestions(): TextInputSuggestion[] {
    const cloudPresets = PROVIDER_PRESETS.filter(p => p.category === 'cloud');
    const localPresets = PROVIDER_PRESETS.filter(p => p.category === 'local');
    return [
      ...cloudPresets.map(preset => ({
        value: preset.id,
        description: `${preset.baseUrl}${preset.suggestedModels?.length ? ' · e.g. ' + preset.suggestedModels.slice(0, 2).join(', ') : ''}`,
        kind: 'provider' as const,
      })),
      ...localPresets.map(preset => ({
        value: preset.id,
        description: `${preset.baseUrl} · local, no API key needed`,
        kind: 'provider' as const,
      })),
      {value: 'custom', description: 'Enter provider name, URL, and API key manually', kind: 'provider' as const},
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

  function lspSuggestions(): TextInputSuggestion[] {
    const servers = configuredLspServers(settings);
    return [{value: 'add server', description: 'add an LSP server (presets available)', kind: 'lsp' as const},
      ...servers.map(server => ({
        value: server.name,
        description: `${server.command}${(server.args ?? []).length ? ` ${(server.args ?? []).join(' ')}` : ''} · ${server.enabled === false ? 'disabled' : 'enabled'}`,
        kind: 'lsp' as const,
      }))];
  }

  function lspActionSuggestions(): TextInputSuggestion[] {
    const server = selectedLspName ? configuredLspServers(settings).find(s => s.name === selectedLspName) : undefined;
    const result: TextInputSuggestion[] = [];
    if (server) result.push({value: server.enabled === false ? 'enable' : 'disable', description: `${server.enabled === false ? 'enable' : 'disable'} this server`, kind: 'lsp' as const});
    result.push({value: 'remove server', description: 'remove this server', kind: 'lsp' as const});
    return result;
  }

  function lspPresetSuggestions(): TextInputSuggestion[] {
    return [
      ...Object.values(LSP_PRESETS).map(preset => ({
        value: preset.name,
        description: `${preset.command} ${(preset.args ?? []).join(' ')} [${(preset.extensions ?? []).join(', ')}]`,
        kind: 'lsp' as const,
      })),
      {value: 'custom', description: 'enter a name and command manually', kind: 'lsp' as const},
    ];
  }

  function mcpSuggestions(): TextInputSuggestion[] {
    const servers = configuredMcpServers(settings);
    return [{value: 'add server', description: 'add an MCP server (presets available)', kind: 'mcp' as const},
      ...servers.map(server => {
        const location = server.url ?? (server.command ? `${server.command} ${(server.args ?? []).join(' ')}`.trim() : '');
        return {value: server.name, description: `${server.transport}${location ? ` ${location}` : ''} · ${server.enabled === false ? 'disabled' : 'enabled'}`, kind: 'mcp' as const};
      })];
  }

  function mcpActionSuggestions(): TextInputSuggestion[] {
    const server = selectedMcpName ? findMcpServer(settings, selectedMcpName) : undefined;
    const result: TextInputSuggestion[] = [];
    if (server) {
      result.push({value: server.enabled === false ? 'enable' : 'disable', description: `${server.enabled === false ? 'enable' : 'disable'} this server`, kind: 'mcp' as const});
      result.push({value: 'set API key', description: server.headers?.length ? 'update the saved API key' : 'add an API key', kind: 'mcp' as const});
    }
    result.push({value: 'remove server', description: 'remove this server', kind: 'mcp' as const});
    return result;
  }

  function mcpPresetSuggestions(): TextInputSuggestion[] {
    return [
      ...presetIds().map(presetId => {
        const preset = findMcpPreset(presetId)!;
        return {value: presetId, description: preset.description ?? `${preset.transport} server`, kind: 'mcp' as const};
      }),
      {value: 'custom', description: 'enter name, transport, and URL or command manually', kind: 'mcp' as const},
    ];
  }

  function mcpTransportSuggestions(): TextInputSuggestion[] {
    return [
      {value: 'http', description: 'Streamable HTTP (remote)', kind: 'mcp' as const},
      {value: 'sse', description: 'Server-Sent Events (remote)', kind: 'mcp' as const},
      {value: 'stdio', description: 'local process', kind: 'mcp' as const},
    ];
  }

  async function selectProvider(providerName: string) {
    if (providerName === 'add provider') {
      setProviderDraft({});
      setMode('providerAddPreset');
      setMessages(m => [...m, {role: 'system', text: 'Choose a provider preset, or select "custom" to enter details manually.'}]);
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

  async function selectPreset(presetId: string) {
    if (presetId === 'custom') {
      setProviderDraft({});
      setMode('providerAddName');
      setMessages(m => [...m, {role: 'system', text: 'Provider name? Example: openrouter, local, lmstudio.'}]);
      return;
    }

    const preset = findPreset(presetId);
    if (!preset) {
      setMessages(m => [...m, {role: 'system', text: `Unknown preset: ${presetId}.`}]);
      return;
    }

    // Check if a provider with this name already exists
    const existingName = settings.providers?.some(p => p.name === preset.name) ? preset.id : preset.name;
    const nameConflict = settings.providers?.some(p => p.name === existingName);
    if (nameConflict) {
      setMessages(m => [...m, {role: 'system', text: `Provider ${existingName} already exists. Use /provider to manage existing providers.`}]);
      setMode('chat');
      setProviderDraft({});
      return;
    }

    setProviderDraft({name: existingName, url: preset.baseUrl});

    if (preset.needsApiKey) {
      setMode('providerAddKey');
      setMessages(m => [...m, {role: 'system', text: `${preset.name} (${preset.baseUrl})\nAPI key${preset.apiKeyHint ? ` (${preset.apiKeyHint})` : ''}?`}]);
    } else {
      // Local/keyless: skip API key, go straight to models
      setMode('providerAddModels');
      const hint = preset.suggestedModels?.length ? ` Example: ${preset.suggestedModels.join(', ')}` : '';
      setMessages(m => [...m, {role: 'system', text: `${preset.name} (${preset.baseUrl}) — no API key needed.\nComma-separated model names?${hint}`}]);
    }
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
    const provider = findProvider(settings, selectedProviderName);
    if (!provider) {
      setMessages(m => [...m, {role: 'system', text: `Provider ${selectedProviderName} not found.`}]);
      setMode('chat');
      setSelectedProviderName(undefined);
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
    if (action === 'set API key') {
      setMode('providerSetKey');
      setMessages(m => [...m, {role: 'system', text: `New API key for ${selectedProviderName}? (current: ${provider.key ? 'saved' : 'not set'})`}]);
      return;
    }
    if (action === 'remove models') {
      setMode('providerRemoveModels');
      setMessages(m => [...m, {role: 'system', text: `Comma-separated model names to remove from ${selectedProviderName}?\nCurrent models: ${provider.models.join(', ')}`}]);
      return;
    }
    if (action === 'remove provider') {
      setMode('providerConfirmRemove');
      setMessages(m => [...m, {role: 'system', text: `Remove provider ${selectedProviderName}? Type "yes" to confirm. Esc to cancel.`}]);
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

  // --- LSP wizard handlers (mirror the provider wizard) ---

  async function selectLspServer(serverName: string) {
    if (serverName === 'add server') {
      setLspDraft({});
      setMode('lspAddPreset');
      setMessages(m => [...m, {role: 'system', text: 'Choose an LSP preset, or select "custom" to enter a name and command manually.'}]);
      return;
    }
    const server = configuredLspServers(settings).find(s => s.name === serverName);
    if (!server) {
      setMessages(m => [...m, {role: 'system', text: `No LSP server named ${serverName}. Use /lsp and choose add server.`}]);
      setMode('chat');
      return;
    }
    setSelectedLspName(server.name);
    setMode('lspAction');
    setMessages(m => [...m, {role: 'system', text: `${server.name}: choose an action.`}]);
  }

  async function selectLspPreset(presetId: string) {
    if (presetId === 'custom') {
      setLspDraft({});
      setMode('lspAddName');
      setMessages(m => [...m, {role: 'system', text: 'LSP server name? Example: typescript, rust, my-lsp.'}]);
      return;
    }
    const preset = lspPreset(presetId);
    if (!preset) {
      setMessages(m => [...m, {role: 'system', text: `Unknown preset: ${presetId}.`}]);
      return;
    }
    if (configuredLspServers(settings).some(s => s.name === preset.name)) {
      setMessages(m => [...m, {role: 'system', text: `LSP server ${preset.name} already exists. Use /lsp to manage existing servers.`}]);
      setMode('chat');
      return;
    }
    const next = await updateSettings({lspServers: upsertLspServer(settings, preset)});
    setSettings(next);
    setMode('chat');
    setMessages(m => [...m, {role: 'system', text: `Added LSP preset ${preset.name}. Ensure ${preset.command} is installed and on PATH; tools appear once it is.`}]);
  }

  async function selectLspAction(action: string) {
    if (!selectedLspName) {
      setMode('lsp');
      return;
    }
    const server = configuredLspServers(settings).find(s => s.name === selectedLspName);
    if (!server) {
      setMessages(m => [...m, {role: 'system', text: `LSP server ${selectedLspName} not found.`}]);
      setMode('chat');
      setSelectedLspName(undefined);
      return;
    }
    if (action === 'enable' || action === 'disable') {
      const next = await updateSettings({lspServers: setLspServerEnabled(settings, selectedLspName, action === 'enable')});
      setSettings(next);
      setMessages(m => [...m, {role: 'system', text: `LSP server ${selectedLspName} ${action === 'enable' ? 'enabled' : 'disabled'}.`}]);
      setSelectedLspName(undefined);
      setMode('chat');
      return;
    }
    if (action === 'remove server') {
      setMode('lspConfirmRemove');
      setMessages(m => [...m, {role: 'system', text: `Remove LSP server ${selectedLspName}? Type "yes" to confirm. Esc to cancel.`}]);
      return;
    }
    setMessages(m => [...m, {role: 'system', text: `Unknown LSP action: ${action}`}]);
  }

  async function finishLspCustom(commandLine: string) {
    const name = lspDraft.name?.trim();
    const parts = commandLine.trim().split(/\s+/).filter(Boolean);
    const command = parts[0];
    if (!name || !command) {
      setMessages(m => [...m, {role: 'system', text: 'LSP server name and command are required.'}]);
      setMode('chat');
      setLspDraft({});
      return;
    }
    const server: HazeLspServer = {name, command, args: parts.slice(1), extensions: [], rootPatterns: ['.git'], enabled: true};
    const next = await updateSettings({lspServers: upsertLspServer(settings, server)});
    setSettings(next);
    setLspDraft({});
    setMode('chat');
    setMessages(m => [...m, {role: 'system', text: `Added LSP server ${name} (${command}${parts.length > 1 ? ` ${parts.slice(1).join(' ')}` : ''}). Add extensions in ~/.haze/settings.json so tools can auto-select it.`}]);
  }

  // --- MCP wizard handlers (mirror the provider wizard) ---

  async function selectMcpServer(serverName: string) {
    if (serverName === 'add server') {
      setMcpDraft({});
      setMode('mcpAddPreset');
      setMessages(m => [...m, {role: 'system', text: 'Choose an MCP preset, or select "custom" to enter details manually.'}]);
      return;
    }
    const server = findMcpServer(settings, serverName);
    if (!server) {
      setMessages(m => [...m, {role: 'system', text: `No MCP server named ${serverName}. Use /mcp and choose add server.`}]);
      setMode('chat');
      return;
    }
    setSelectedMcpName(server.name);
    setMode('mcpAction');
    setMessages(m => [...m, {role: 'system', text: `${server.name}: choose an action.`}]);
  }

  async function selectMcpPreset(presetId: string) {
    if (presetId === 'custom') {
      setMcpDraft({});
      setMode('mcpAddName');
      setMessages(m => [...m, {role: 'system', text: 'MCP server name? Example: context7, github, filesystem.'}]);
      return;
    }
    const preset = findMcpPreset(presetId);
    if (!preset) {
      setMessages(m => [...m, {role: 'system', text: `Unknown preset: ${presetId}.`}]);
      return;
    }
    if (findMcpServer(settings, presetId)) {
      setMessages(m => [...m, {role: 'system', text: `MCP server ${presetId} already exists. Use /mcp to manage existing servers.`}]);
      setMode('chat');
      return;
    }
    setMcpDraft({name: presetId, transport: preset.transport, ...(preset.url ? {url: preset.url} : {})});
    setMode('mcpAddKey');
    setMessages(m => [...m, {role: 'system', text: `Adding ${presetId} (${preset.transport}${preset.url ? `, ${preset.url}` : ''}).\nOptional API key or auth header value? (Leave blank to skip — Enter works.)`}]);
  }

  async function selectMcpAction(action: string) {
    if (!selectedMcpName) {
      setMode('mcp');
      return;
    }
    const server = findMcpServer(settings, selectedMcpName);
    if (!server) {
      setMessages(m => [...m, {role: 'system', text: `MCP server ${selectedMcpName} not found.`}]);
      setMode('chat');
      setSelectedMcpName(undefined);
      return;
    }
    if (action === 'enable' || action === 'disable') {
      const toggled = toggleMcpServer(settings, selectedMcpName, action === 'enable');
      const next = await updateSettings({mcpServers: toggled ?? []});
      setSettings(next);
      setMessages(m => [...m, {role: 'system', text: `MCP server ${selectedMcpName} ${action === 'enable' ? 'enabled' : 'disabled'}.`}]);
      setSelectedMcpName(undefined);
      setMode('chat');
      return;
    }
    if (action === 'set API key') {
      setMode('mcpSetKey');
      setMessages(m => [...m, {role: 'system', text: `New API key for ${selectedMcpName}? (current: ${server.headers?.length ? 'saved' : 'not set'}) Sent as Authorization: Bearer <value>.`}]);
      return;
    }
    if (action === 'remove server') {
      setMode('mcpConfirmRemove');
      setMessages(m => [...m, {role: 'system', text: `Remove MCP server ${selectedMcpName}? Type "yes" to confirm. Esc to cancel.`}]);
      return;
    }
    setMessages(m => [...m, {role: 'system', text: `Unknown MCP action: ${action}`}]);
  }

  async function finishMcpCustom(keyValue?: string) {
    const name = mcpDraft.name?.trim();
    const transport = mcpDraft.transport;
    if (!name || !transport) {
      setMessages(m => [...m, {role: 'system', text: 'MCP server name and transport are required.'}]);
      setMode('chat');
      setMcpDraft({});
      return;
    }
    const headers = keyValue?.trim() ? [{name: 'Authorization', value: `Bearer ${keyValue.trim()}`}] : undefined;
    const server: HazeMcpServer = transport === 'stdio'
      ? {name, transport, command: mcpDraft.command, args: mcpDraft.args, ...(headers ? {headers} : {}), enabled: true}
      : {name, transport, url: mcpDraft.url, ...(headers ? {headers} : {}), enabled: true};
    // Re-validate the transport-specific required field.
    if (transport === 'stdio' && !server.command) {
      setMessages(m => [...m, {role: 'system', text: 'Command is required for stdio transport.'}]);
      setMode('chat');
      setMcpDraft({});
      return;
    }
    if (transport !== 'stdio' && !server.url) {
      setMessages(m => [...m, {role: 'system', text: `URL is required for ${transport} transport.`}]);
      setMode('chat');
      setMcpDraft({});
      return;
    }
    const next = await updateSettings({mcpServers: upsertMcpServer(settings, server)});
    setSettings(next);
    setMcpDraft({});
    setMode('chat');
    const location = transport === 'stdio' ? `${server.command}${(server.args ?? []).length ? ` ${(server.args ?? []).join(' ')}` : ''}` : server.url;
    setMessages(m => [...m, {role: 'system', text: `Added MCP server ${name} (${transport}, ${location}). Tools load on the next turn.`}]);
  }

  async function setMcpServerKey(keyValue: string) {
    if (!selectedMcpName) {
      setMode('mcp');
      return;
    }
    const server = findMcpServer(settings, selectedMcpName);
    if (!server) {
      setMessages(m => [...m, {role: 'system', text: `MCP server ${selectedMcpName} not found.`}]);
      setMode('chat');
      setSelectedMcpName(undefined);
      return;
    }
    const key = keyValue.trim();
    if (!key) {
      setMessages(m => [...m, {role: 'system', text: 'API key cannot be empty. Esc to cancel.'}]);
      return;
    }
    const headers = (server.headers ?? []).filter(header => header.name !== 'Authorization');
    headers.push({name: 'Authorization', value: `Bearer ${key}`});
    const next = await updateSettings({mcpServers: upsertMcpServer(settings, {...server, headers})});
    setSettings(next);
    setSelectedMcpName(undefined);
    setMode('chat');
    setMessages(m => [...m, {role: 'system', text: `API key updated for ${server.name}.`}]);
  }

  async function captureSkillName(value: string) {
    const dirName = toSkillDirName(value);
    if (!dirName) {
      setMessages(m => [...m, {role: 'system', text: 'Skill name must contain at least one letter or number. Try again, or press ESC to cancel.'}]);
      return;
    }
    const registry = await loadSkillRegistry();
    if (registry.skills.has(dirName)) {
      setMessages(m => [...m, {role: 'system', text: `A skill named "${dirName}" already exists. Pick another name, or press ESC to cancel.`}]);
      return;
    }
    setSkillCreateDraft(d => ({...d, name: dirName}));
    setMode('skillCreateRole');
    setMessages(m => [...m, {role: 'system', text: `Skill wizard — step 2/3: Role for "${dirName}". Describe who the skill should be (optional — press Enter to skip, ESC to cancel).`}]);
  }

  function captureSkillRole(value: string) {
    const role = value.trim();
    setSkillCreateDraft(d => ({...d, ...(role ? {role} : {})}));
    setMode('skillCreateDescription');
    setMessages(m => [...m, {role: 'system', text: `Skill wizard — step 3/3: Describe what the skill should do. This is the work the LLM will expand into the skill body.`}]);
  }

  async function captureSkillDescription(value: string) {
    const description = value.trim();
    if (!description) {
      setMessages(m => [...m, {role: 'system', text: 'Description is required. Try again, or press ESC to cancel.'}]);
      return;
    }
    const name = skillCreateDraft.name;
    if (!name) {
      setMode('chat');
      setSkillCreateDraft({});
      setMessages(m => [...m, {role: 'system', text: 'Skill wizard lost the name. Start over with /create-skill.'}]);
      return;
    }
    setMode('chat');
    setBusyLabel('Creating skill');
    setBusy(true);
    try {
      const result = await createSkill({name, role: skillCreateDraft.role, description});
      setMessages(m => [...m, {role: 'system', text: `Created skill ${result.name} at ${result.file}. Invoke it with /${result.name}. Edit SKILL.md to refine its workflow.`}]);
      await refreshSkills();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessages(m => [...m, {role: 'system', text: `Skill creation failed: ${text}`}]);
    } finally {
      setSkillCreateDraft({});
      setBusy(false);
      setBusyLabel('Haze is thinking');
    }
  }

  async function submit(value: string) {
    if (busy) {
      if (mode === 'chat') queueFollowUp(value);
      return;
    }

    if (mode === 'skillCreateName') {
      await captureSkillName(value);
      return;
    }

    if (mode === 'skillCreateRole') {
      captureSkillRole(value);
      return;
    }

    if (mode === 'skillCreateDescription') {
      await captureSkillDescription(value);
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

    if (mode === 'providerAddPreset') {
      await selectPreset(value);
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

    if (mode === 'providerSetKey') {
      const provider = selectedProviderName ? findProvider(settings, selectedProviderName) : undefined;
      if (!provider) {
        setMessages(m => [...m, {role: 'system', text: 'No provider selected.'}]);
        setMode('chat');
        return;
      }
      const key = value.trim();
      if (!key) {
        setMessages(m => [...m, {role: 'system', text: 'API key cannot be empty. Esc to cancel.'}]);
        return;
      }
      const updated = {...provider, key};
      const next = await updateSettings({providers: upsertProvider(settings, updated)});
      setSettings(next);
      setSelectedProviderName(undefined);
      setMode('chat');
      setMessages(m => [...m, {role: 'system', text: `API key updated for ${provider.name}.`}]);
      return;
    }

    if (mode === 'providerRemoveModels') {
      const provider = selectedProviderName ? findProvider(settings, selectedProviderName) : undefined;
      if (!provider) {
        setMessages(m => [...m, {role: 'system', text: 'No provider selected.'}]);
        setMode('chat');
        return;
      }
      const toRemove = value.split(',').map(m => m.trim()).filter(Boolean);
      if (toRemove.length === 0) {
        setMessages(m => [...m, {role: 'system', text: 'Enter at least one model name. Esc to cancel.'}]);
        return;
      }
      const remaining = provider.models.filter(m => !toRemove.includes(m));
      if (remaining.length === 0) {
        setMessages(m => [...m, {role: 'system', text: 'A provider must have at least one model. Remove the provider instead.'}]);
        return;
      }
      const removed = provider.models.filter(m => toRemove.includes(m));
      const notFound = toRemove.filter(m => !provider.models.includes(m));
      const updated = {...provider, models: remaining};
      const wasActive = settings.model && provider.models.includes(settings.model) && !remaining.includes(settings.model);
      const next = await updateSettings({
        providers: upsertProvider(settings, updated),
        ...(wasActive ? {model: remaining[0]} : {}),
      });
      setSettings(next);
      setSelectedProviderName(undefined);
      setMode('chat');
      const parts = [`Removed ${removed.join(', ')} from ${provider.name}.`];
      if (notFound.length) parts.push(`Not found: ${notFound.join(', ')}.`);
      if (wasActive) parts.push(`Active model updated to ${remaining[0]}.`);
      setMessages(m => [...m, {role: 'system', text: parts.join(' ')}]);
      return;
    }

    if (mode === 'providerConfirmRemove') {
      const provider = selectedProviderName ? findProvider(settings, selectedProviderName) : undefined;
      if (!provider) {
        setMessages(m => [...m, {role: 'system', text: 'No provider selected.'}]);
        setMode('chat');
        return;
      }
      if (value.trim().toLowerCase() !== 'yes') {
        setMessages(m => [...m, {role: 'system', text: 'Cancelled. Provider not removed.'}]);
        setSelectedProviderName(undefined);
        setMode('chat');
        return;
      }
      const providers = configuredProviders(settings).filter(p => p.name !== selectedProviderName);
      const wasActiveProvider = settings.provider === selectedProviderName || (!settings.provider && configuredProviders(settings)[0]?.name === selectedProviderName);
      const next = await updateSettings({
        providers,
        ...(wasActiveProvider ? {provider: providers[0]?.name, model: providers[0]?.models[0]} : {}),
      });
      setSettings(next);
      setSelectedProviderName(undefined);
      setMode('chat');
      setMessages(m => [...m, {role: 'system', text: `Removed provider ${provider.name}.${wasActiveProvider ? ` Switched to ${providers[0]?.name ?? 'no provider'}.` : ''}`}]);
      return;
    }

    if (mode === 'lsp') {
      await selectLspServer(value);
      return;
    }
    if (mode === 'lspAction') {
      await selectLspAction(value);
      return;
    }
    if (mode === 'lspAddPreset') {
      await selectLspPreset(value);
      return;
    }
    if (mode === 'lspAddName') {
      const name = value.trim();
      if (!name) {
        setMessages(m => [...m, {role: 'system', text: 'LSP server name is required.'}]);
        return;
      }
      if (configuredLspServers(settings).some(s => s.name === name)) {
        setMessages(m => [...m, {role: 'system', text: `LSP server ${name} already exists. Choose a unique name.`}]);
        return;
      }
      setLspDraft({name});
      setMode('lspAddCommand');
      setMessages(m => [...m, {role: 'system', text: 'Command to run? Example: typescript-language-server --stdio'}]);
      return;
    }
    if (mode === 'lspAddCommand') {
      await finishLspCustom(value);
      return;
    }
    if (mode === 'lspConfirmRemove') {
      if (!selectedLspName) {
        setMode('chat');
        return;
      }
      if (value.trim().toLowerCase() !== 'yes') {
        setMessages(m => [...m, {role: 'system', text: 'Cancelled. LSP server not removed.'}]);
        setSelectedLspName(undefined);
        setMode('chat');
        return;
      }
      const next = await updateSettings({lspServers: removeLspServer(settings, selectedLspName)});
      setSettings(next);
      setMessages(m => [...m, {role: 'system', text: `Removed LSP server ${selectedLspName}.`}]);
      setSelectedLspName(undefined);
      setMode('chat');
      return;
    }

    if (mode === 'mcp') {
      await selectMcpServer(value);
      return;
    }
    if (mode === 'mcpAction') {
      await selectMcpAction(value);
      return;
    }
    if (mode === 'mcpAddPreset') {
      await selectMcpPreset(value);
      return;
    }
    if (mode === 'mcpAddName') {
      const name = value.trim();
      if (!name) {
        setMessages(m => [...m, {role: 'system', text: 'MCP server name is required.'}]);
        return;
      }
      if (findMcpServer(settings, name)) {
        setMessages(m => [...m, {role: 'system', text: `MCP server ${name} already exists. Choose a unique name.`}]);
        return;
      }
      setMcpDraft({name});
      setMode('mcpAddTransport');
      setMessages(m => [...m, {role: 'system', text: 'Transport type? http (Streamable HTTP), sse (Server-Sent Events), or stdio (local process).'}]);
      return;
    }
    if (mode === 'mcpAddTransport') {
      const transport = value.trim().toLowerCase();
      if (transport !== 'http' && transport !== 'sse' && transport !== 'stdio') {
        setMessages(m => [...m, {role: 'system', text: 'Enter http, sse, or stdio.'}]);
        return;
      }
      setMcpDraft(draft => ({...draft, transport: transport as 'http' | 'sse' | 'stdio'}));
      if (transport === 'stdio') {
        setMode('mcpAddCommand');
        setMessages(m => [...m, {role: 'system', text: 'Command to run? Example: npx -y @modelcontextprotocol/server-filesystem .'}]);
      } else {
        setMode('mcpAddUrl');
        setMessages(m => [...m, {role: 'system', text: `MCP server URL? Example: https://mcp.context7.com/mcp for ${transport}.`}]);
      }
      return;
    }
    if (mode === 'mcpAddUrl') {
      try {
        new URL(value);
      } catch {
        setMessages(m => [...m, {role: 'system', text: 'Enter a valid URL, for example https://mcp.context7.com/mcp.'}]);
        return;
      }
      setMcpDraft(draft => ({...draft, url: value.trim()}));
      setMode('mcpAddKey');
      setMessages(m => [...m, {role: 'system', text: 'Optional API key or auth header value? (Leave blank to skip — Enter works.) Sent as Authorization: Bearer <value>.'}]);
      return;
    }
    if (mode === 'mcpAddCommand') {
      const parts = value.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        setMessages(m => [...m, {role: 'system', text: 'Command is required.'}]);
        return;
      }
      setMcpDraft(draft => ({...draft, command: parts[0], args: parts.slice(1)}));
      setMode('mcpAddKey');
      setMessages(m => [...m, {role: 'system', text: 'Optional API key or auth header value? (Leave blank to skip — Enter works.) Sent as Authorization: Bearer <value>.'}]);
      return;
    }
    if (mode === 'mcpAddKey') {
      await finishMcpCustom(value);
      return;
    }
    if (mode === 'mcpSetKey') {
      await setMcpServerKey(value);
      return;
    }
    if (mode === 'mcpConfirmRemove') {
      if (!selectedMcpName) {
        setMode('chat');
        return;
      }
      if (value.trim().toLowerCase() !== 'yes') {
        setMessages(m => [...m, {role: 'system', text: 'Cancelled. MCP server not removed.'}]);
        setSelectedMcpName(undefined);
        setMode('chat');
        return;
      }
      const next = await updateSettings({mcpServers: removeMcpServer(settings, selectedMcpName)});
      setSettings(next);
      setMessages(m => [...m, {role: 'system', text: `Removed MCP server ${selectedMcpName}.`}]);
      setSelectedMcpName(undefined);
      setMode('chat');
      return;
    }

    const invokedSkill = skillInvocation(value);
    if (invokedSkill) {
      const argumentText = invokedSkill.args ? `\nUser-provided skill arguments: ${invokedSkill.args}` : '';
      await doAgentTurn(`The user explicitly invoked the "${invokedSkill.skill.name}" skill. Call skill with name="${invokedSkill.skill.name}" and follow its returned instructions.${argumentText}`, value);
      return;
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
    try {
      result = await handleSlashCommand(value, ctx);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessages(m => [...m, {role: 'system', text: `Command failed: ${text}`}]);
      return;
    }
    if (result === 'exit') return exit();
    if (result === 'handled') {
      if (value.startsWith('/remove-skill ')) {
        await refreshSkills().catch(() => undefined);
      }
      if (value === '/clear') {
        loadTasksFromStore().then(t => { setVisibleTasks(t); setTaskBarPadding(0); }).catch(() => undefined);
      }
      return;
    }

    await doAgentTurn(value);
  }

  async function doAgentTurn(value: string, displayValue?: string) {
    setDebugLogs([]);
    // When every task is already completed, start the new turn with a clean
    // slate: the task bar clears (nothing shown for simple questions) and the
    // model may create fresh todos via writeTasks if the new question warrants.
    if (visibleTasks.length > 0 && visibleTasks.every(t => t.status === 'completed')) {
      setVisibleTasks([]);
      setTasksExpanded(false);
      setTaskBarPadding(0);
      await clearTasksFromStore().catch(() => undefined);
    }
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
      const ordered = withDisplayOrder(msg);
      setMessages(m => [...m, ordered]);
      persistUiMessage(ordered);
    };

    await runAgentTurn(value, displayValue, contextFiles, {
      addMessage: msg => {
        const ordered = withDisplayOrder(msg);
        if (ordered.streaming) {
          setLiveMessagesState(m => [...m, ordered]);
          return;
        }
        finalizeMessage(ordered);
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
      setWorkState: state => {
        workStateRef.current = state;
        const session = sessionRef.current;
        if (session) void appendSessionEntry(session, {type: 'work_state_snapshot', at: new Date().toISOString(), state}).catch(() => undefined);
      },
      compactConversation,
      recordTokenUsage: usage => {
        setTokenUsage(current => ({
          inputTokens: (current.inputTokens ?? 0) + (usage.inputTokens ?? 0) || usage.inputTokens,
          outputTokens: (current.outputTokens ?? 0) + (usage.outputTokens ?? 0) || usage.outputTokens,
          systemPrompt: current.systemPrompt + usage.systemPrompt,
          messages: current.messages + usage.messages,
          toolSchemas: current.toolSchemas + usage.toolSchemas,
          outputEstimate: current.outputEstimate + usage.outputEstimate,
          cacheReadTokens: current.cacheReadTokens + usage.cacheReadTokens,
          cacheWriteTokens: current.cacheWriteTokens + usage.cacheWriteTokens,
          noCacheTokens: current.noCacheTokens + usage.noCacheTokens,
          reasoningTokens: current.reasoningTokens + usage.reasoningTokens,
          logicalInputEstimate: current.logicalInputEstimate + usage.logicalInputEstimate,
          effectiveNonCachedInput: (current.effectiveNonCachedInput ?? 0) + (usage.effectiveNonCachedInput ?? 0) || usage.effectiveNonCachedInput,
        }));
      },
      onEvent: event => {
        const session = sessionRef.current;
        if (session) void appendSessionEntry(session, {type: 'event', at: event.at, name: event.type, text: JSON.stringify(event)}).catch(() => undefined);
      },
      onTasksChanged: () => { loadTasksFromStore().then(t => { setVisibleTasks(t); setTaskBarPadding(0); }).catch(() => undefined); },
      log: llmLogRef.current,
    }, 0, false, false, {start: sessionStartRef.current, cwd: process.cwd()});
  }

  const visible = messages.filter(message => !message.hidden);
  const activeLiveMessages = liveMessages.filter(message => !message.hidden);
  const orderedVisibleMessages = orderedDisplayMessages([...visible, ...activeLiveMessages]);
  const annotatedDisplayMessages = annotateTurnHeaders(orderedVisibleMessages);
  const staticDisplayItems = annotatedDisplayMessages.filter(item => !item.message.streaming);
  const transcriptItems = staticDisplayItems.map((item, index) => ({key: messageKey(item.message, index), ...item}));
  const activeLiveItems = annotatedDisplayMessages.filter(item => item.message.streaming);
  const activeSelection = activeModel(settings);
  const PLACEHOLDERS: Partial<Record<Mode, string>> = {
    provider: 'Choose provider',
    providerAction: 'Choose provider action',
    providerAddPreset: 'Choose a provider preset or custom',
    model: 'Choose model',
    providerAddName: 'Provider name',
    providerAddUrl: 'https://example.com/v1',
    providerAddKey: 'API key, or blank for local',
    providerSetKey: 'API key',
    providerAddModels: 'model-a, model-b',
    providerAppendModels: 'model-a, model-b',
    providerRemoveModels: 'model-a, model-b',
    providerConfirmRemove: 'Type "yes" to confirm',
    skillCreateName: 'Skill name (kebab-case, e.g. security-review)',
    skillCreateRole: 'Role (optional — Enter to skip)',
    skillCreateDescription: 'Describe what the skill should do',
    lsp: 'Choose LSP server or add server',
    lspAction: 'enable, disable, or remove server',
    lspAddPreset: 'Choose an LSP preset or custom',
    lspAddName: 'LSP server name (e.g. typescript)',
    lspAddCommand: 'Command (e.g. typescript-language-server --stdio)',
    lspConfirmRemove: 'Type "yes" to confirm',
    mcp: 'Choose MCP server or add server',
    mcpAction: 'enable, disable, remove, or set key',
    mcpAddPreset: 'Choose an MCP preset or custom',
    mcpAddName: 'MCP server name (e.g. context7)',
    mcpAddTransport: 'http, sse, or stdio',
    mcpAddUrl: 'https://mcp.example.com/mcp',
    mcpAddCommand: 'Command (e.g. npx -y @pkg/server)',
    mcpAddKey: 'API key, or blank to skip',
    mcpSetKey: 'API key',
    mcpConfirmRemove: 'Type "yes" to confirm',
  };
  const placeholder = PLACEHOLDERS[mode] ?? (busy ? 'Queue a follow-up, or Esc to interrupt' : 'Ask Haze to help build your app');
  const activeModelName = activeSelection ? `${activeSelection.provider.name}:${activeSelection.model}` : 'unconfigured';
  const headerSubtitle = [
    'A minimal LLM harness for growing your own workflows while you work.',
    '',
    'Start with simple chat, then teach Haze your habits with skills:',
    '/create-skill  — three-step skill wizard (name, role, description).',
    '',
    'The most adaptive workflow is the one you shape as you go.',
    '',
    'Guardrails are light: Haze lets the LLM work from the terminal almost like you,',
    'while trying to stay scoped to this project.',
  ].join('\n');
  const workspaceLabel = `${compactHomePath(process.cwd())}${branchName ? ` (${branchName})` : ''}`;
  const allDisplayMessages = [...messages, ...liveMessages];
  const hazeMessages = allDisplayMessages.filter(message => message.role === 'assistant' && !message.hidden).length;
  const toolsUsed = toolCallCount(allDisplayMessages);
  const fallbackTokens = estimateConversationTokens(allDisplayMessages);
  const estimatedLogicalInput = tokenUsage.logicalInputEstimate || fallbackTokens.input || 0;
  const providerInput = tokenUsage.inputTokens;
  const effectiveInput = providerInput == null ? estimatedLogicalInput : Math.max(providerInput, estimatedLogicalInput);
  const effectiveOutput = tokenUsage.outputTokens ?? (fallbackTokens.output || 0);
  const inputEstimated = providerInput == null || effectiveInput !== providerInput;
  const outputEstimated = tokenUsage.outputTokens == null;
  const statusDetailLabel = `${hazeMessages} haze message${hazeMessages === 1 ? '' : 's'} / ${toolsUsed} tool call${toolsUsed === 1 ? '' : 's'} / LLM ${inputEstimated ? '~' : ''}↑${formatTokenCount(effectiveInput)} ${outputEstimated ? '~' : ''}↓${formatTokenCount(effectiveOutput)} / ${skills.length} skill${skills.length === 1 ? '' : 's'}`;
  const hasTokenBreakdown = tokenUsage.systemPrompt > 0 || tokenUsage.messages > 0 || tokenUsage.toolSchemas > 0 || effectiveInput > 0 || effectiveOutput > 0;
  const goalText = activeGoalStatus?.replace(/^Goal:\s*/, '');
  // Goal tracking is internal; display removed in favor of task bar
  void goalText;
  const inputSuggestions: TextInputSuggestion[] = mode === 'provider' ? providerSuggestions() : mode === 'providerAction' ? providerActionSuggestions() : mode === 'providerAddPreset' ? presetSuggestions() : mode === 'model' ? modelSuggestions() : mode === 'lsp' ? lspSuggestions() : mode === 'lspAction' ? lspActionSuggestions() : mode === 'lspAddPreset' ? lspPresetSuggestions() : mode === 'mcp' ? mcpSuggestions() : mode === 'mcpAction' ? mcpActionSuggestions() : mode === 'mcpAddPreset' ? mcpPresetSuggestions() : mode === 'mcpAddTransport' ? mcpTransportSuggestions() : mode === 'chat' ? [
    {value: '/help', description: 'Show commands', kind: 'command'},
    {value: '/provider', description: 'Choose a provider', kind: 'command'},
    {value: '/model', description: 'Choose a model', kind: 'command'},
    {value: '/lsp', description: 'Manage LSP servers (semantic navigation)', kind: 'command'},
    {value: '/mcp', description: 'Manage MCP servers (Context7, etc.)', kind: 'command'},
    {value: '/settings', description: 'Show provider, model, API key, and context status', kind: 'command'},
    {value: '/create-skill ', description: 'Launch the skill wizard', kind: 'command'},
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
    {kind: 'header' as const, key: `header-${activeModelName}`, subtitle: headerSubtitle},
    ...transcriptItems.map(item => ({kind: 'message' as const, ...item})),
  ];

  return <Box flexDirection="column">
    <Static items={staticItems}>
      {item => item.kind === 'header'
        ? <Header key={item.key} subtitle={item.subtitle} version={version} />
        : <MessageView key={item.key} message={item.message} width={width} suppressAssistantHeader={item.suppressAssistantHeader} />}
    </Static>
    {activeLiveItems.length > 0 && <Box flexDirection="column" flexShrink={0}>
      {activeLiveItems.map((item, index) => <MessageView key={messageKey(item.message, index)} message={item.message} width={width} suppressAssistantHeader={item.suppressAssistantHeader} />)}
    </Box>}
    {debug && debugLogs.length > 0 && <Box flexDirection="column" flexShrink={0} marginBottom={1} borderStyle="round" borderColor={theme.muted} paddingX={1}>
      <Text color={theme.muted} bold>Debug</Text>
      {debugLogs.map((line, index) => <Text key={index} color={theme.muted}>• {line}</Text>)}
    </Box>}
    {queuedFollowUps.length > 0 && <Box flexDirection="column" flexShrink={0} marginBottom={1}>
      <Text color={theme.muted}>Queued follow-ups:</Text>
      {queuedFollowUps.map((item, index) => <Text key={`${index}-${item}`} color={theme.muted} dimColor>  {index + 1}. {item}</Text>)}
    </Box>}
    {visibleTasks.length > 0 && <Box flexDirection="column" flexShrink={0} marginBottom={1}>
      <TaskBarContent tasks={visibleTasks} width={width} expanded={tasksExpanded} padding={taskBarPadding} />
    </Box>}
    {busy && <Box flexShrink={0}>
      <Text><Text color={theme.orange} bold><Spinner type="dots" /> {busyLabel}</Text><Text color={theme.muted} dimColor> · type to queue follow-up · esc to interrupt</Text></Text>
    </Box>}
    <Box borderStyle="round" borderColor={theme.deepPurple} paddingX={1} flexShrink={0}>
      <Box flexGrow={1} minWidth={0}>
        <TextInput
          placeholder={placeholder}
          disabled={busy && mode !== 'chat'}
          mask={MASKED_MODES.has(mode)}
          historyItems={inputHistory}
          recordHistory={mode === 'chat'}
          suggestions={inputSuggestions}
          suggestionMode={PICKER_MODES.has(mode) ? 'always' : 'slash'}
          submitOnEmpty={SUBMIT_EMPTY_MODES.has(mode)}
          width={Math.max(20, width - 4)}
          onHistoryAdd={persistInputHistory}
          onToggleTasks={() => {
            if (!tasksExpanded) {
              setTaskBarPadding(0);
              setTasksExpanded(true);
            } else {
              const expandedRows = visibleTasks.length + 1;
              const collapsedRows = Math.min(visibleTasks.length, MAX_VISIBLE_TASKS) + 1;
              setTaskBarPadding(Math.max(0, expandedRows - collapsedRows));
              setTasksExpanded(false);
            }
          }}
          onCancel={cancelThinking}
          onEscape={() => {
            if (busy) cancelThinking();
            else closeInputList();
          }}
          onSubmit={submit}
        />
      </Box>
    </Box>
    {debug && hasTokenBreakdown && <Box flexShrink={0} flexDirection="column" paddingX={1}>
      <Text color={theme.muted} bold>Token usage {inputEstimated || outputEstimated ? '(estimated)' : '(precise)'}</Text>
      <Text color={theme.muted}>  in={formatTokenCount(effectiveInput)} out={formatTokenCount(effectiveOutput)}{tokenUsage.cacheReadTokens > 0 ? ` cached=${formatTokenCount(tokenUsage.cacheReadTokens)}` : ''}{tokenUsage.noCacheTokens > 0 ? ` uncached=${formatTokenCount(tokenUsage.noCacheTokens)}` : ''}{tokenUsage.cacheWriteTokens > 0 ? ` cache_write=${formatTokenCount(tokenUsage.cacheWriteTokens)}` : ''}{tokenUsage.reasoningTokens > 0 ? ` reasoning=${formatTokenCount(tokenUsage.reasoningTokens)}` : ''}</Text>
      <Text color={theme.muted}>  logical={formatTokenCount(tokenUsage.logicalInputEstimate)}{tokenUsage.effectiveNonCachedInput != null ? ` effective_non_cached=${formatTokenCount(tokenUsage.effectiveNonCachedInput)}` : ''}</Text>
      <Text color={theme.muted}>  system={formatTokenCount(tokenUsage.systemPrompt)} messages={formatTokenCount(tokenUsage.messages)} tools={formatTokenCount(tokenUsage.toolSchemas)} output={formatTokenCount(tokenUsage.outputEstimate)}</Text>
    </Box>}
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
  await clearTasksFromStore().catch(() => undefined);
  const app = render(<ChatScreen debug={options.debug} version={options.version} continueSession={options.continueSession} noSession={options.noSession} />);
  await app.waitUntilExit();
  await clearTasksFromStore().catch(() => undefined);
}
