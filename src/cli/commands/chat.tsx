import React, {useEffect, useRef, useState} from 'react';
import {execFile as execFileCallback} from 'node:child_process';
import os from 'node:os';
import {promisify} from 'node:util';
import fs from 'fs-extra';
import {Box, render, Static, Text, useApp, useStdout} from 'ink';
import Spinner from 'ink-spinner';
import {type ModelMessage} from 'ai';
import {readContextFiles, type ContextFile} from '../../config/contextFiles.js';
import {checkForUpdate} from '../../config/updateCheck.js';
import {addInputHistoryItem, readInputHistory} from '../../config/inputHistory.js';
import {loadTasks as loadTasksFromStore, clearTasks as clearTasksFromStore} from '../../core/tasks/taskStorage.js';
import type {Task} from '../../core/tasks/taskStorage.js';
import {readSettings, updateSettings, type HazeMcpServer, type HazeProviderSettings, type HazeSettings} from '../../config/settings.js';
import {activeModel, configuredProviders, findProvider, modelSelector, resolveModelSelector, upsertProvider} from '../../config/providers.js';
import {configuredLspServers, lspPreset, removeLspServer, setLspServerEnabled, upsertLspServer, type HazeLspServer} from '../../config/lspSettings.js';
import {findMcpPreset, findMcpServer, removeMcpServer, toggleMcpServer, upsertMcpServer} from '../../config/mcpSettings.js';
import {isSkillEnabled, removeSkillSetting, setSkillEnabled} from '../../config/skillSettings.js';
import {Header} from '../../ui/components/Header.js';
import {TextInput} from '../../ui/components/TextInput.js';
import {theme} from '../../ui/theme.js';
import {handleSlashCommand, type CommandContext} from './commands.js';
import {runAgentTurn, type Message, type TokenUsage} from './streaming.js';
import {formatContextReport} from './formatters.js';
import {type LlmLog, createLog as createLlmLog, endLog as endLlmLog} from '../../core/log/llmLog.js';
import {loadSkillRegistry} from '../../skills/SkillRegistry.js';
import {createSkill, toSkillDirName} from '../../skills/builder/SkillBuilder.js';
import {findPreset} from '../../config/providerPresets.js';
import type {LoadedSkill} from '../../skills/types.js';
import {appendSessionEntry, createSession, formatSession, latestSession, restoreConversation, restoreWorkState, type HazeSession} from '../../core/session/sessionStore.js';
import {compactModelMessages, modelMessageText} from '../../core/agent/compaction.js';
import {contextBreakdown} from '../../core/agent/contextBudget.js';
import {stripSyntheticControls} from '../../core/agent/requestAssembly.js';
import {modelWithConfig} from '../../llm/client.js';
import {assembleRequestContext} from '../../llm/requestContext.js';
import {closeMcpClients} from '../../llm/mcp.js';
import type {WorkState} from '../../core/agent/workState.js';
import {MAX_VISIBLE_TASKS, TaskBar} from '../chat/TaskBar.js';
import {clearToolOutputs} from '../../core/agent/toolOutputStore.js';
import {MessageView, messageKey, orderedDisplayMessages} from '../chat/messages.js';
import {createSessionRecorder} from '../chat/sessionRecorder.js';
import {startupProviderInfo} from '../chat/startupInfo.js';
import {MASKED_MODES, PICKER_MODES, SUBMIT_EMPTY_MODES, placeholderForMode, type Mode} from './chatModes.js';
import {inputSuggestionsForState} from '../chat/inputSuggestions.js';
import {COMMON_ACTIONS, LSP_ACTIONS, MCP_ACTIONS, MCP_TRANSPORTS, PROVIDER_ACTIONS, PROVIDER_CHOICES, SERVER_CHOICES, SKILL_ACTIONS, SKILL_CHOICES, YES_CONFIRMATION} from './wizardActions.js';

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
  const [, setActiveGoalStatus] = useState<string | undefined>();
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
  const [skillDraft, setSkillDraft] = useState<{name?: string}>({});
  const [selectedSkillName, setSelectedSkillName] = useState<string | undefined>();
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
    // Disabled skills are not invocable: they are absent from the model catalog,
    // mirroring how disabled LSP/MCP tools never load.
    return skill && isSkillEnabled(settings, skill.name) ? {skill, args: args.join(' ')} : undefined;
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

  async function buildContextReport(): Promise<string> {
    const runtime = await modelWithConfig({cwd: process.cwd()});
    if (!runtime?.model) {
      return 'No model provider configured. Run /provider to choose or add a provider before /context can estimate tokens.';
    }
    const session = {start: sessionStartRef.current, cwd: process.cwd()};
    const assembled = await assembleRequestContext({contextFiles, session, model: runtime.model});
    try {
      const messages = stripSyntheticControls(conversationRef.current);
      const breakdown = contextBreakdown({system: assembled.systemPrompt, contextFiles, messages, tools: assembled.availableTools});
      const tools = breakdown.toolSchemas.map(tool => ({
        name: tool.name,
        tokens: tool.tokens,
        category: assembled.toolCategories.get(tool.name) ?? 'builtin',
      }));
      return formatContextReport({
        modelLabel: `${runtime.config.providerName}:${runtime.config.modelName}`,
        systemTokens: breakdown.system,
        projectContext: breakdown.projectContext,
        tools,
        messagesByRole: breakdown.messagesByRole,
        toolResults: breakdown.toolResults,
        toolInputs: breakdown.toolInputs,
        syntheticControl: breakdown.syntheticControl,
        logicalInputEstimate: breakdown.logicalInputEstimate,
        messageCount: messages.length,
        mcpErrors: assembled.loadedMcp?.errors ?? [],
      });
    } finally {
      if (assembled.loadedMcp?.clients.length) await closeMcpClients(assembled.loadedMcp.clients);
    }
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
      setSkillDraft({});
      setSelectedSkillName(undefined);
      setSelectedLspName(undefined);
      setLspDraft({});
      setSelectedMcpName(undefined);
      setMcpDraft({});
    }
  }

  async function selectProvider(providerName: string) {
    if (providerName === PROVIDER_CHOICES.addProvider) {
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
    if (presetId === PROVIDER_CHOICES.custom) {
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
    if (action === PROVIDER_ACTIONS.useProvider) {
      await useProvider(selectedProviderName);
      return;
    }
    if (action === PROVIDER_ACTIONS.addModels) {
      setMode('providerAppendModels');
      setMessages(m => [...m, {role: 'system', text: `Comma-separated model names to add to ${selectedProviderName}?`}]);
      return;
    }
    if (action === PROVIDER_ACTIONS.setApiKey) {
      setMode('providerSetKey');
      setMessages(m => [...m, {role: 'system', text: `New API key for ${selectedProviderName}? (current: ${provider.key ? 'saved' : 'not set'})`}]);
      return;
    }
    if (action === PROVIDER_ACTIONS.removeModels) {
      setMode('providerRemoveModels');
      setMessages(m => [...m, {role: 'system', text: `Comma-separated model names to remove from ${selectedProviderName}?\nCurrent models: ${provider.models.join(', ')}`}]);
      return;
    }
    if (action === PROVIDER_ACTIONS.removeProvider) {
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
    if (serverName === SERVER_CHOICES.addServer) {
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
    if (presetId === SERVER_CHOICES.custom) {
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
    if (action === COMMON_ACTIONS.enable || action === COMMON_ACTIONS.disable) {
      const next = await updateSettings({lspServers: setLspServerEnabled(settings, selectedLspName, action === COMMON_ACTIONS.enable)});
      setSettings(next);
      setMessages(m => [...m, {role: 'system', text: `LSP server ${selectedLspName} ${action === COMMON_ACTIONS.enable ? 'enabled' : 'disabled'}.`}]);
      setSelectedLspName(undefined);
      setMode('chat');
      return;
    }
    if (action === LSP_ACTIONS.removeServer) {
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
    if (serverName === SERVER_CHOICES.addServer) {
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
    if (presetId === SERVER_CHOICES.custom) {
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
    if (action === COMMON_ACTIONS.enable || action === COMMON_ACTIONS.disable) {
      const toggled = toggleMcpServer(settings, selectedMcpName, action === COMMON_ACTIONS.enable);
      const next = await updateSettings({mcpServers: toggled ?? []});
      setSettings(next);
      setMessages(m => [...m, {role: 'system', text: `MCP server ${selectedMcpName} ${action === COMMON_ACTIONS.enable ? 'enabled' : 'disabled'}.`}]);
      setSelectedMcpName(undefined);
      setMode('chat');
      return;
    }
    if (action === MCP_ACTIONS.setApiKey) {
      setMode('mcpSetKey');
      setMessages(m => [...m, {role: 'system', text: `New API key for ${selectedMcpName}? (current: ${server.headers?.length ? 'saved' : 'not set'}) Sent as Authorization: Bearer <value>.`}]);
      return;
    }
    if (action === MCP_ACTIONS.removeServer) {
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
    const server: HazeMcpServer = transport === MCP_TRANSPORTS.stdio
      ? {name, transport, command: mcpDraft.command, args: mcpDraft.args, ...(headers ? {headers} : {}), enabled: true}
      : {name, transport, url: mcpDraft.url, ...(headers ? {headers} : {}), enabled: true};
    // Re-validate the transport-specific required field.
    if (transport === MCP_TRANSPORTS.stdio && !server.command) {
      setMessages(m => [...m, {role: 'system', text: 'Command is required for stdio transport.'}]);
      setMode('chat');
      setMcpDraft({});
      return;
    }
    if (transport !== MCP_TRANSPORTS.stdio && !server.url) {
      setMessages(m => [...m, {role: 'system', text: `URL is required for ${transport} transport.`}]);
      setMode('chat');
      setMcpDraft({});
      return;
    }
    const next = await updateSettings({mcpServers: upsertMcpServer(settings, server)});
    setSettings(next);
    setMcpDraft({});
    setMode('chat');
    const location = transport === MCP_TRANSPORTS.stdio ? `${server.command}${(server.args ?? []).length ? ` ${(server.args ?? []).join(' ')}` : ''}` : server.url;
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

  // --- Skills wizard handlers (mirror the provider/LSP/MCP wizards) ---

  async function selectSkill(name: string) {
    if (name === SKILL_CHOICES.addSkill) {
      setSkillDraft({});
      setMode('skillsAddName');
      setMessages(m => [...m, {role: 'system', text: 'Name the skill (kebab-case, e.g. security-review). ESC cancels.'}]);
      return;
    }
    const skill = skills.find(candidate => candidate.name === name);
    if (!skill) {
      setMessages(m => [...m, {role: 'system', text: `No skill named ${name}. Use /skills and choose add skill.`}]);
      setMode('chat');
      return;
    }
    setSelectedSkillName(skill.name);
    setMode('skillsAction');
    setMessages(m => [...m, {role: 'system', text: `${skill.name}: choose an action.`}]);
  }

  async function selectSkillAction(action: string) {
    if (!selectedSkillName) {
      setMode('skills');
      return;
    }
    const skill = skills.find(candidate => candidate.name === selectedSkillName);
    if (!skill) {
      setMessages(m => [...m, {role: 'system', text: `Skill ${selectedSkillName} not found.`}]);
      setMode('chat');
      setSelectedSkillName(undefined);
      return;
    }
    if (action === COMMON_ACTIONS.enable || action === COMMON_ACTIONS.disable) {
      const next = await updateSettings({skills: setSkillEnabled(settings, selectedSkillName, action === COMMON_ACTIONS.enable)});
      setSettings(next);
      setMessages(m => [...m, {role: 'system', text: `Skill ${selectedSkillName} ${action === COMMON_ACTIONS.enable ? 'enabled' : 'disabled'}.`}]);
      setSelectedSkillName(undefined);
      setMode('chat');
      return;
    }
    if (action === SKILL_ACTIONS.showInfo) {
      setMessages(m => [...m, {role: 'system', text: [
        `${skill.name}`,
        skill.description,
        '',
        `References: ${skill.references.length}`,
        `Path: ${skill.dir}`,
        `State: ${isSkillEnabled(settings, skill.name) ? 'enabled' : 'disabled'}`,
      ].join('\n')}]);
      return;
    }
    if (action === SKILL_ACTIONS.validate) {
      const {loadSkill} = await import('../../skills/SkillLoader.js');
      try {
        const loaded = await loadSkill(skill.dir, 'global');
        setMessages(m => [...m, {role: 'system', text: loaded ? `Valid: ${loaded.name}` : 'No SKILL.md found'}]);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        setMessages(m => [...m, {role: 'system', text: `Invalid skill: ${text}`}]);
      }
      return;
    }
    if (action === SKILL_ACTIONS.removeSkill) {
      setMode('skillsConfirmRemove');
      setMessages(m => [...m, {role: 'system', text: `Remove skill ${selectedSkillName}? This deletes ~/.haze/skills/${selectedSkillName}. Type "yes" to confirm. Esc to cancel.`}]);
      return;
    }
    setMessages(m => [...m, {role: 'system', text: `Unknown skill action: ${action}`}]);
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
    setSkillDraft(d => ({...d, name: dirName}));
    setMode('skillsAddDescription');
    setMessages(m => [...m, {role: 'system', text: `Describe what "${dirName}" should do. This is the work the LLM will expand into the skill body.`}]);
  }

  async function captureSkillDescription(value: string) {
    const description = value.trim();
    if (!description) {
      setMessages(m => [...m, {role: 'system', text: 'Description is required. Try again, or press ESC to cancel.'}]);
      return;
    }
    const name = skillDraft.name;
    if (!name) {
      setMode('chat');
      setSkillDraft({});
      setMessages(m => [...m, {role: 'system', text: 'Skill wizard lost the name. Start over with /skills.'}]);
      return;
    }
    setMode('chat');
    setSkillDraft({});
    setBusyLabel('Creating skill');
    setBusy(true);
    try {
      const result = await createSkill({name, description});
      setMessages(m => [...m, {role: 'system', text: `Created skill ${result.name} at ${result.file}. Invoke it with /${result.name}. Edit SKILL.md to refine its workflow.`}]);
      await refreshSkills();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessages(m => [...m, {role: 'system', text: `Skill creation failed: ${text}`}]);
    } finally {
      setBusy(false);
      setBusyLabel('Haze is thinking');
    }
  }

  async function submit(value: string) {
    if (busy) {
      if (mode === 'chat') queueFollowUp(value);
      return;
    }

    if (mode === 'skills') {
      await selectSkill(value);
      return;
    }
    if (mode === 'skillsAction') {
      await selectSkillAction(value);
      return;
    }
    if (mode === 'skillsAddName') {
      await captureSkillName(value);
      return;
    }
    if (mode === 'skillsAddDescription') {
      await captureSkillDescription(value);
      return;
    }
    if (mode === 'skillsConfirmRemove') {
      if (!selectedSkillName) {
        setMode('chat');
        return;
      }
      if (value.trim().toLowerCase() !== YES_CONFIRMATION) {
        setMessages(m => [...m, {role: 'system', text: 'Cancelled. Skill not removed.'}]);
        setSelectedSkillName(undefined);
        setMode('chat');
        return;
      }
      const skill = skills.find(candidate => candidate.name === selectedSkillName);
      if (!skill) {
        setMessages(m => [...m, {role: 'system', text: `Skill ${selectedSkillName} not found.`}]);
        setSelectedSkillName(undefined);
        setMode('chat');
        return;
      }
      await fs.remove(skill.dir);
      const next = await updateSettings({skills: removeSkillSetting(settings, selectedSkillName)});
      setSettings(next);
      setMessages(m => [...m, {role: 'system', text: `Removed skill ${selectedSkillName}.`}]);
      setSelectedSkillName(undefined);
      setMode('chat');
      await refreshSkills();
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
      if (value.trim().toLowerCase() !== YES_CONFIRMATION) {
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
      if (value.trim().toLowerCase() !== YES_CONFIRMATION) {
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
      if (transport !== MCP_TRANSPORTS.http && transport !== MCP_TRANSPORTS.sse && transport !== MCP_TRANSPORTS.stdio) {
        setMessages(m => [...m, {role: 'system', text: 'Enter http, sse, or stdio.'}]);
        return;
      }
      setMcpDraft(draft => ({...draft, transport: transport as HazeMcpServer['transport']}));
      if (transport === MCP_TRANSPORTS.stdio) {
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
      if (value.trim().toLowerCase() !== YES_CONFIRMATION) {
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
      getContextReport: async () => buildContextReport(),
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
    const sessionRecorder = createSessionRecorder(() => sessionRef.current);
    const finalizeMessage = (msg: Message) => {
      if (msg.hidden) return;
      const ordered = withDisplayOrder(msg);
      setMessages(m => [...m, ordered]);
      sessionRecorder.recordUiMessage(ordered);
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
        sessionRecorder.recordConversation(msgs);
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
        sessionRecorder.recordWorkState(state);
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
        sessionRecorder.recordEvent(event);
      },
      onTasksChanged: () => { loadTasksFromStore().then(t => { setVisibleTasks(t); setTaskBarPadding(0); }).catch(() => undefined); },
      log: llmLogRef.current,
    }, 0, false, false, {start: sessionStartRef.current, cwd: process.cwd()});
  }

  const visible = messages.filter(message => !message.hidden);
  const activeLiveMessages = liveMessages.filter(message => !message.hidden);
  const orderedVisibleMessages = orderedDisplayMessages([...visible, ...activeLiveMessages]);
  const transcriptItems = orderedVisibleMessages.filter(message => !message.streaming).map((message, index) => ({key: messageKey(message, index), message}));
  const streamingItems = orderedVisibleMessages.filter(message => message.streaming);
  const activeSelection = activeModel(settings);
  const placeholder = placeholderForMode(mode, busy);
  const activeModelName = activeSelection ? `${activeSelection.provider.name}:${activeSelection.model}` : 'unconfigured';
  const headerSubtitle = [
    'A minimal LLM harness for growing your own workflows while you work.',
    '',
    'Start with simple chat, then teach Haze your habits with skills:',
    '/skills  — add, enable/disable, validate, or remove Markdown skills.',
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
  const enabledSkills = skills.filter(skill => isSkillEnabled(settings, skill.name));
  const statusDetailLabel = `${hazeMessages} haze message${hazeMessages === 1 ? '' : 's'} / ${toolsUsed} tool call${toolsUsed === 1 ? '' : 's'} / LLM ${inputEstimated ? '~' : ''}↑${formatTokenCount(effectiveInput)} ${outputEstimated ? '~' : ''}↓${formatTokenCount(effectiveOutput)} / ${enabledSkills.length} skill${enabledSkills.length === 1 ? '' : 's'}`;
  const hasTokenBreakdown = tokenUsage.systemPrompt > 0 || tokenUsage.messages > 0 || tokenUsage.toolSchemas > 0 || effectiveInput > 0 || effectiveOutput > 0;
  const inputSuggestions = inputSuggestionsForState({mode, settings, skills, selectedProviderName, modelProviderFilter, selectedSkillName, selectedLspName, selectedMcpName});
  const staticItems = [
    {kind: 'header' as const, key: `header-${activeModelName}`, subtitle: headerSubtitle},
    ...transcriptItems.map(item => ({kind: 'message' as const, ...item})),
  ];

  return <Box flexDirection="column">
    <Static items={staticItems}>
      {item => item.kind === 'header'
        ? <Header key={item.key} subtitle={item.subtitle} version={version} />
        : <MessageView key={item.key} message={item.message} width={width} />}
    </Static>
    {streamingItems.length > 0 && <Box flexDirection="column" flexShrink={0}>
      {streamingItems.map((message, index) => <MessageView key={messageKey(message, index)} message={message} width={width} />)}
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
      <TaskBar tasks={visibleTasks} width={width} expanded={tasksExpanded} padding={taskBarPadding} />
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
