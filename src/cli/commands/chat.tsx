import React, {useEffect, useRef, useState} from 'react';
import {execFile as execFileCallback} from 'node:child_process';
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
import {activeModel, findProvider, modelSelector, resolveModelSelector} from '../../config/providers.js';
import {removeLspServer, type HazeLspServer} from '../../config/lspSettings.js';
import {removeMcpServer} from '../../config/mcpSettings.js';
import {isSkillEnabled} from '../../config/skillSettings.js';
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
import {compactModelMessages} from '../../core/agent/compaction.js';
import {contextBreakdown} from '../../core/agent/contextBudget.js';
import {stripSyntheticControls} from '../../core/agent/requestAssembly.js';
import {modelWithConfig} from '../../llm/client.js';
import {assembleRequestContext} from '../../llm/requestContext.js';
import {closeMcpClients} from '../../llm/mcp.js';
import {checkBudget} from '../../core/usage/budget.js';
import {costForUsage, priceForModel} from '../../core/usage/pricing.js';
import {HAZE_DIR} from '../../config/paths.js';
import type {WorkState} from '../../core/agent/workState.js';
import {MAX_VISIBLE_TASKS, TaskBar} from '../chat/TaskBar.js';
import {clearToolOutputs} from '../../core/agent/toolOutputStore.js';
import {MessageView, messageKey, orderedDisplayMessages} from '../chat/messages.js';
import {createSessionRecorder} from '../chat/sessionRecorder.js';
import {startupContextInfo, startupProviderInfo} from '../chat/startupInfo.js';
import {compactHomePath, displayMessagesFromConversation, estimateConversationTokens, formatTokenCount, toolCallCount} from '../chat/chatMetrics.js';
import {accumulateTokenUsage, EMPTY_TOKEN_USAGE, shouldClearCompletedTasks} from '../chat/turnState.js';
import {MASKED_MODES, PICKER_MODES, SUBMIT_EMPTY_MODES, placeholderForMode, type Mode} from './chatModes.js';
import {inputSuggestionsForState} from '../chat/inputSuggestions.js';
import {PROVIDER_ACTIONS, PROVIDER_CHOICES, SERVER_CHOICES} from './wizardActions.js';
import {captureLspName, captureMcpCommand, captureMcpName, captureMcpTransport, captureMcpUrl, captureProviderName, captureProviderUrl} from './wizardPrompts.js';
import {finishLspCustomResult, selectLspActionResult, selectLspPresetResult, selectLspServerResult} from './lspWizard.js';
import {finishMcpCustomResult, selectMcpActionResult, selectMcpPresetResult, selectMcpServerResult, setMcpServerKeyResult} from './mcpWizard.js';
import {providerActionResult, providerAppendModels, providerFinishAdd, providerRemove, providerRemoveModels, providerSetKey} from './providerWizard.js';
import {selectSkillActionResult, selectSkillResult} from './skillWizard.js';
import {captureSkillDescription as captureSkillDescriptionResult, skillCreationFailure, skillCreationMessage} from './skillCreation.js';
import {skillConfirmRemoveResult as skillConfirmRemove} from './skillConfirmRemove.js';
import {commandParts, isYesConfirmation} from './wizardInput.js';

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
  const contextFileSignaturesRef = useRef<Map<string, string>>(new Map());
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
  const [sessionCost, setSessionCost] = useState<number | undefined>(undefined);
  const budgetWarningsRef = useRef<Set<string>>(new Set());
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
    Promise.all([
      readSettings().catch(() => ({} as HazeSettings)),
      currentBranchName().catch(() => undefined),
      readContextFiles().catch(() => [] as ContextFile[]),
    ]).then(([next, branch, files]) => {
      setSettings(next);
      setBranchName(branch);
      setContextFiles(files);
      contextFileSignaturesRef.current = new Map(files.flatMap(file => file.signature ? [[file.path, file.signature] as const] : []));
      setMessages(m => [...m, {role: 'system', text: `${startupProviderInfo(next)}\n\n${startupContextInfo(files)}`}]);
    }).catch(() => undefined);
    initializeSession().catch(error => {
      const text = error instanceof Error ? error.message : String(error);
      setMessages(m => [...m, {role: 'system', text: `Session disabled: ${text}`}]);
    });
    readInputHistory().then(setInputHistory).catch(() => undefined);
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
    const [name, ...args] = commandParts(value.slice(1));
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
    contextFileSignaturesRef.current = new Map(contextFiles.flatMap(file => file.signature ? [[file.path, file.signature] as const] : []));
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
        const {messages: conversation, parseErrors: conversationErrors} = await restoreConversation(session);
        sessionRef.current = session;
        sessionStartRef.current = new Date();
        conversationRef.current = conversation;
        setSessionLabel(session.id);
        setLiveMessagesState(() => []);
        const restoredMessages = displayMessagesFromConversation(conversation);
        setTokenUsage({...EMPTY_TOKEN_USAGE, messages: estimateConversationTokens(restoredMessages).input, outputEstimate: estimateConversationTokens(restoredMessages).output});
        const {state: workState, parseErrors: workStateErrors} = await restoreWorkState(session);
        workStateRef.current = workState;
        for (const error of [...conversationErrors, ...workStateErrors]) {
          debugLog(`Session parse error: ${error}`);
        }
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
    const {messages: conversation, parseErrors: conversationErrors} = await restoreConversation(session);
    const {state: workState, parseErrors: workStateErrors} = await restoreWorkState(session);
    for (const error of [...conversationErrors, ...workStateErrors]) {
      debugLog(`Session parse error: ${error}`);
    }
    clearToolOutputs();
    sessionRef.current = session;
    conversationRef.current = conversation;
    workStateRef.current = workState;
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
    const actionResult = providerActionResult(action, provider);
    if (actionResult.selectedName === undefined) setSelectedProviderName(undefined);
    if (actionResult.mode) setMode(actionResult.mode);
    showWizardMessage(actionResult.message);
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
    const result = providerAppendModels(settings, selectedProviderName, modelsValue);
    if (!result.provider) {
      setMessages(m => [...m, {role: 'system', text: result.message}]);
      setMode('chat');
      return;
    }
    if (!result.settingsPatch) {
      setMessages(m => [...m, {role: 'system', text: result.message}]);
      return;
    }
    const next = await updateSettings(result.settingsPatch);
    setSettings(next);
    setSelectedProviderName(undefined);
    setModelProviderFilter(result.provider.name);
    setMode('model');
    setMessages(m => [...m, {role: 'system', text: result.message}]);
  }

  async function finishProviderAdd(modelsValue: string) {
    const result = providerFinishAdd(settings, providerDraft, modelsValue);
    if (!result.provider || !result.settingsPatch) {
      setMessages(m => [...m, {role: 'system', text: result.message}]);
      setMode('chat');
      setProviderDraft({});
      return;
    }
    const next = await updateSettings(result.settingsPatch);
    setSettings(next);
    setProviderDraft({});
    setModelProviderFilter(result.provider.name);
    setMode('model');
    setMessages(m => [...m, {role: 'system', text: result.message}]);
  }

  // --- LSP wizard handlers (mirror the provider wizard) ---

  function showWizardMessage(message: string | undefined) {
    if (message) setMessages(m => [...m, {role: 'system', text: message}]);
  }

  async function selectLspServer(serverName: string) {
    const result = selectLspServerResult(settings, serverName);
    if (result.clearDraft) setLspDraft({});
    if (serverName === SERVER_CHOICES.addServer) setMode('lspAddPreset');
    else if (result.mode) setMode(result.mode);
    if (result.selectedName !== undefined) setSelectedLspName(result.selectedName);
    showWizardMessage(result.message);
  }

  async function selectLspPreset(presetId: string) {
    const result = selectLspPresetResult(settings, presetId);
    if (result.clearDraft) setLspDraft({});
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if (result.mode) setMode(result.mode);
    showWizardMessage(result.message);
  }

  async function selectLspAction(action: string) {
    const result = selectLspActionResult(settings, selectedLspName, action);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if ('selectedName' in result) setSelectedLspName(result.selectedName);
    if (result.mode) setMode(result.mode);
    showWizardMessage(result.message);
  }

  async function finishLspCustom(commandLine: string) {
    const result = finishLspCustomResult(settings, lspDraft.name, commandLine);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if (result.clearDraft) setLspDraft({});
    if (result.mode) setMode(result.mode);
    showWizardMessage(result.message);
  }

  // --- MCP wizard handlers (mirror the provider wizard) ---

  async function selectMcpServer(serverName: string) {
    const result = selectMcpServerResult(settings, serverName);
    if (result.clearDraft) setMcpDraft({});
    if (serverName === SERVER_CHOICES.addServer) setMode('mcpAddPreset');
    else if (result.mode) setMode(result.mode);
    if (result.selectedName !== undefined) setSelectedMcpName(result.selectedName);
    showWizardMessage(result.message);
  }

  async function selectMcpPreset(presetId: string) {
    const result = selectMcpPresetResult(settings, presetId);
    if (result.clearDraft) setMcpDraft({});
    if (result.draft) setMcpDraft(result.draft);
    if (result.mode) setMode(result.mode);
    showWizardMessage(result.message);
  }

  async function selectMcpAction(action: string) {
    const result = selectMcpActionResult(settings, selectedMcpName, action);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if ('selectedName' in result) setSelectedMcpName(result.selectedName);
    if (result.mode) setMode(result.mode);
    showWizardMessage(result.message);
  }

  async function finishMcpCustom(keyValue?: string) {
    const result = finishMcpCustomResult(settings, mcpDraft, keyValue);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if (result.clearDraft) setMcpDraft({});
    if (result.mode) setMode(result.mode);
    showWizardMessage(result.message);
  }

  async function setMcpServerKey(keyValue: string) {
    const result = setMcpServerKeyResult(settings, selectedMcpName, keyValue);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if ('selectedName' in result) setSelectedMcpName(result.selectedName);
    if (result.mode) setMode(result.mode);
    showWizardMessage(result.message);
  }

  // --- Skills wizard handlers (mirror the provider/LSP/MCP wizards) ---

  async function selectSkill(name: string) {
    const result = selectSkillResult(skills, name);
    if (result.clearDraft) setSkillDraft({});
    if ('selectedName' in result) setSelectedSkillName(result.selectedName);
    if (result.mode) setMode(result.mode);
    showWizardMessage(result.message);
  }

  async function selectSkillAction(action: string) {
    const result = selectSkillActionResult(settings, skills, selectedSkillName, action);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if ('selectedName' in result) setSelectedSkillName(result.selectedName);
    if (result.mode) setMode(result.mode);
    if (result.validate && result.skill) {
      const {loadSkill} = await import('../../skills/SkillLoader.js');
      try {
        const loaded = await loadSkill(result.skill.dir, 'global');
        showWizardMessage(loaded ? `Valid: ${loaded.name}` : 'No SKILL.md found');
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        showWizardMessage(`Invalid skill: ${text}`);
      }
      return;
    }
    showWizardMessage(result.message);
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
    const result = captureSkillDescriptionResult(value, skillDraft.name);
    if (result.message) {
      const message = result.message;
      setMessages(m => [...m, {role: 'system', text: message}]);
    }
    if (result.mode === 'chat') setMode('chat');
    if (result.clearDraft) setSkillDraft({});
    if (result.description && result.draftName) {
      const name = result.draftName;
      const description = result.description;
      setBusyLabel(result.busyLabel ?? 'Creating skill');
      setBusy(true);
      try {
        const created = await createSkill({name, description});
        setMessages(m => [...m, {role: 'system', text: skillCreationMessage(created.name, created.file)}]);
        await refreshSkills();
      } catch (error) {
        setMessages(m => [...m, {role: 'system', text: skillCreationFailure(error)}]);
      } finally {
        setBusy(false);
        setBusyLabel('Haze is thinking');
      }
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
      const result = skillConfirmRemove(settings, skills, selectedSkillName, value);
      if (result.message) {
        const message = result.message;
        setMessages(m => [...m, {role: 'system', text: message}]);
      }
      if (result.selectedName === undefined) setSelectedSkillName(undefined);
      if (result.mode === 'chat') setMode('chat');
      if (result.removedDir) await fs.remove(result.removedDir);
      if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
      if (result.removedDir) await refreshSkills();
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
      const result = captureProviderName(settings, value);
      if (result.message) {
        showWizardMessage(result.message);
        return;
      }
      if (result.draft) setProviderDraft({name: result.draft.name});
      if (result.nextMode) setMode(result.nextMode as typeof mode);
      showWizardMessage(result.systemMessage);
      return;
    }

    if (mode === 'providerAddUrl') {
      const result = captureProviderUrl(value);
      if (result.message) {
        showWizardMessage(result.message);
        return;
      }
      if (result.draft) setProviderDraft(draft => ({...draft, ...result.draft}));
      if (result.nextMode) setMode(result.nextMode as typeof mode);
      showWizardMessage(result.systemMessage);
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
      const result = providerSetKey(settings, selectedProviderName, value);
      if (!result.provider) {
        setMessages(m => [...m, {role: 'system', text: result.message}]);
        setMode('chat');
        return;
      }
      if (!result.settingsPatch) {
        setMessages(m => [...m, {role: 'system', text: result.message}]);
        return;
      }
      setSettings(await updateSettings(result.settingsPatch));
      setSelectedProviderName(undefined);
      setMode('chat');
      setMessages(m => [...m, {role: 'system', text: result.message}]);
      return;
    }

    if (mode === 'providerRemoveModels') {
      const result = providerRemoveModels(settings, selectedProviderName, value);
      if (!result.provider) {
        setMessages(m => [...m, {role: 'system', text: result.message}]);
        setMode('chat');
        return;
      }
      if (!result.settingsPatch) {
        setMessages(m => [...m, {role: 'system', text: result.message}]);
        return;
      }
      const next = await updateSettings(result.settingsPatch);
      setSettings(next);
      setSelectedProviderName(undefined);
      setMode('chat');
      setMessages(m => [...m, {role: 'system', text: result.message}]);
      return;
    }

    if (mode === 'providerConfirmRemove') {
      const provider = selectedProviderName ? findProvider(settings, selectedProviderName) : undefined;
      if (!provider) {
        setMessages(m => [...m, {role: 'system', text: 'No provider selected.'}]);
        setMode('chat');
        return;
      }
      if (!isYesConfirmation(value)) {
        setMessages(m => [...m, {role: 'system', text: 'Cancelled. Provider not removed.'}]);
        setSelectedProviderName(undefined);
        setMode('chat');
        return;
      }
      const result = providerRemove(settings, selectedProviderName);
      const next = await updateSettings(result.settingsPatch ?? {});
      setSettings(next);
      setSelectedProviderName(undefined);
      setMode('chat');
      setMessages(m => [...m, {role: 'system', text: result.message}]);
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
      const result = captureLspName(settings, value);
      if (result.message) {
        showWizardMessage(result.message);
        return;
      }
      if (result.draft) setLspDraft({name: result.draft.name});
      if (result.nextMode) setMode(result.nextMode as typeof mode);
      showWizardMessage(result.systemMessage);
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
      if (!isYesConfirmation(value)) {
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
      const result = captureMcpName(settings, value);
      if (result.message) {
        showWizardMessage(result.message);
        return;
      }
      if (result.draft) setMcpDraft({name: result.draft.name});
      if (result.nextMode) setMode(result.nextMode as typeof mode);
      showWizardMessage(result.systemMessage);
      return;
    }
    if (mode === 'mcpAddTransport') {
      const result = captureMcpTransport(value);
      if (result.message) {
        showWizardMessage(result.message);
        return;
      }
      if (result.draft) setMcpDraft(draft => ({...draft, ...result.draft}));
      if (result.nextMode) setMode(result.nextMode as typeof mode);
      showWizardMessage(result.systemMessage);
      return;
    }
    if (mode === 'mcpAddUrl') {
      const result = captureMcpUrl(value);
      if (result.message) {
        showWizardMessage(result.message);
        return;
      }
      if (result.draft) setMcpDraft(draft => ({...draft, ...result.draft}));
      if (result.nextMode) setMode(result.nextMode as typeof mode);
      showWizardMessage(result.systemMessage);
      return;
    }
    if (mode === 'mcpAddCommand') {
      const result = captureMcpCommand(value);
      if (result.message) {
        showWizardMessage(result.message);
        return;
      }
      if (result.draft) setMcpDraft(draft => ({...draft, ...result.draft}));
      if (result.nextMode) setMode(result.nextMode as typeof mode);
      showWizardMessage(result.systemMessage);
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
      if (!isYesConfirmation(value)) {
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
      refreshContextFiles: async () => {
        const files = await readContextFiles().catch(() => contextFiles);
        setContextFiles(files);
        contextFileSignaturesRef.current = new Map(files.flatMap(file => file.signature ? [[file.path, file.signature] as const] : []));
        return files;
      },
      updateSettings: async patch => {
        const next = await updateSettings(patch);
        setSettings(next);
        return next;
      },
      getContextReport: async () => buildContextReport(),
      sessionStart: sessionStartRef.current,
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
    if (shouldClearCompletedTasks(visibleTasks)) {
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
        setTokenUsage(current => {
          const next = accumulateTokenUsage(current, usage);
          void (async () => {
            const active = activeModel(settings);
            if (!active) return;
            const runtime = {providerName: active.provider.name, modelName: active.model};
            const warning = await checkBudget({settings, sessionUsage: next, runtime, baseDir: HAZE_DIR});
            if (warning && !budgetWarningsRef.current.has(warning.key)) {
              budgetWarningsRef.current.add(warning.key);
              setMessages(m => [...m, {role: 'system', text: warning.message}]);
            }
          })();
          return next;
        });
        void (async () => {
          const active = activeModel(settings);
          if (!active) return;
          const price = await priceForModel(active.provider.name, active.model);
          if (price) {
            setSessionCost(prev => (prev ?? 0) + costForUsage(usage, price));
          }
        })();
      },
      onEvent: event => {
        sessionRecorder.recordEvent(event);
      },
      onTasksChanged: () => { loadTasksFromStore().then(t => { setVisibleTasks(t); setTaskBarPadding(0); }).catch(() => undefined); },
      contextFileSignatures: contextFileSignaturesRef.current,
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
  const costLabel = sessionCost != null ? ` / ~$${sessionCost.toFixed(4)}` : '';
  const statusDetailLabel = `${hazeMessages} haze message${hazeMessages === 1 ? '' : 's'} / ${toolsUsed} tool call${toolsUsed === 1 ? '' : 's'} / LLM ${inputEstimated ? '~' : ''}↑${formatTokenCount(effectiveInput)} ${outputEstimated ? '~' : ''}↓${formatTokenCount(effectiveOutput)}${costLabel} / ${enabledSkills.length} skill${enabledSkills.length === 1 ? '' : 's'}`;
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
