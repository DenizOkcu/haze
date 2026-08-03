import React, {useEffect, useRef, useState} from 'react';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {Box, render, Static, Text, useApp, useStdout} from 'ink';
import Spinner from 'ink-spinner';
import {type ModelMessage} from 'ai';
import {readContextFiles, type ContextFile} from '../../config/contextFiles.js';
import {checkForUpdate} from '../../config/updateCheck.js';
import {addInputHistoryItem, readInputHistory} from '../../config/inputHistory.js';
import {loadTasks as loadTasksFromStore, clearTasks as clearTasksFromStore} from '../../core/tasks/taskStorage.js';
import type {Task} from '../../core/tasks/taskStorage.js';
import {readSettings, updateSettings, type HazeMcpServer, type HazeProviderSettings, type HazeSettings} from '../../config/settings.js';
import {activeModel} from '../../config/providers.js';
import {type HazeLspServer} from '../../config/lspSettings.js';
import {isSkillEnabled} from '../../config/skillSettings.js';
import {Header} from '../../ui/components/Header.js';
import {TextInput} from '../../ui/components/TextInput.js';
import {theme} from '../../ui/theme.js';
import {handleSlashCommand, type CommandContext} from './commands.js';
import {runAgentTurn, type Message, type TokenUsage} from './streaming.js';
import {formatElapsedTimeWhole} from './formatters.js';
import {type LlmLog, endLog as endLlmLog} from '../../core/log/llmLog.js';
import {loadSkillRegistry} from '../../skills/SkillRegistry.js';
import type {LoadedSkill} from '../../skills/types.js';
import {formatSession, type HazeSession} from '../../core/session/sessionStore.js';
import type {WorkState} from '../../core/agent/workState.js';
import {MAX_VISIBLE_TASKS, TaskBar} from '../chat/TaskBar.js';
import {MessageView, messageKey, orderedDisplayMessages} from '../chat/messages.js';
import {createSessionRecorder, type SessionRecorder} from '../chat/sessionRecorder.js';
import {createSessionLifecycle} from '../chat/sessionLifecycle.js';
import {createWizardDispatch} from '../chat/wizardDispatch.js';
import {buildContextReport} from '../chat/contextReport.js';
import {startupContextInfo, startupProviderInfo} from '../chat/startupInfo.js';
import {compactHomePath, formatTokenCount, statusBarMetrics} from '../chat/chatMetrics.js';
import {accumulateTokenUsage, EMPTY_TOKEN_USAGE, shouldClearCompletedTasks} from '../chat/turnState.js';
import {MASKED_MODES, PICKER_MODES, SUBMIT_EMPTY_MODES, placeholderForMode, type Mode} from './chatModes.js';
import {inputSuggestionsForState} from '../chat/inputSuggestions.js';
import {modelThinkingLabel} from '../../utils/modelName.js';
import {transitionMcpField, transitionProviderField} from './wizardTransition.js';
import {commandParts} from './wizardInput.js';

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

/** Elapsed-time label for the busy indicator heartbeat, or '' when no turn is active. */
function busyElapsedLabel(startedAt: number | undefined) {
  if (startedAt == null) return '';
  const elapsed = Date.now() - startedAt;
  return elapsed > 0 ? formatElapsedTimeWhole(elapsed) : '';
}

function thinkingLabelForSettings(settings: HazeSettings) {
  return modelThinkingLabel(activeModel(settings)?.model);
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
    {role: 'system', text: 'Welcome to haze. Use /help for commands.', displayOrder: 0}
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
  const [settingsError, setSettingsError] = useState<string | undefined>();
  const conversationRef = useRef<ModelMessage[]>([]);
  const lastAssistantTextRef = useRef('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<HazeSession | undefined>(undefined);
  const sessionRecorderRef = useRef<SessionRecorder | undefined>(undefined);
  if (!sessionRecorderRef.current) sessionRecorderRef.current = createSessionRecorder(() => sessionRef.current);
  const sessionStartRef = useRef<Date>(new Date());
  const workStateRef = useRef<WorkState | undefined>(undefined);
  const llmLogRef = useRef<LlmLog | undefined>(undefined);
  const persistenceWarningShownRef = useRef(false);
  const skillErrorSignatureRef = useRef('');
  const contextFileSignaturesRef = useRef<Map<string, string>>(new Map());
  const followUpQueueRef = useRef<string[]>([]);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  const [mode, setMode] = useState<Mode>('chat');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState(() => thinkingLabelForSettings(settings));
  // Heartbeat for the busy indicator: ticks every second while haze is working
  // so the developer always sees rolling activity (elapsed turn time) even when
  // the model is thinking with no streamed output and no tool is running.
  const turnStartedAtRef = useRef<number | undefined>(undefined);
  const [, setBusyTick] = useState(0);
  const [visibleTasks, setVisibleTasks] = useState<Task[]>([]);
  const [tasksExpanded, setTasksExpanded] = useState(false);
  const [taskBarPadding, setTaskBarPadding] = useState(0);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>({...EMPTY_TOKEN_USAGE});
  const [queuedFollowUps, setQueuedFollowUps] = useState<string[]>([]);
  const [skills, setSkills] = useState<LoadedSkill[]>([]);
  const [branchName, setBranchName] = useState<string | undefined>();
  const [modelProviderFilter, setModelProviderFilter] = useState<string | undefined>();
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [selectedProviderName, setSelectedProviderName] = useState<string | undefined>();
  const [providerDraft, setProviderDraft] = useState<Partial<HazeProviderSettings>>({});
  const [skillDraft, setSkillDraft] = useState<{name?: string}>({});
  const [selectedSkillName, setSelectedSkillName] = useState<string | undefined>();
  const [selectedLspName, setSelectedLspName] = useState<string | undefined>();
  const [lspDraft, setLspDraft] = useState<Partial<HazeLspServer>>({});
  const [selectedMcpName, setSelectedMcpName] = useState<string | undefined>();
  const [mcpDraft, setMcpDraft] = useState<Partial<HazeMcpServer>>({});

  // Wrap setBusy so the busy indicator knows when the turn started, and tick a
  // heartbeat every second while busy so elapsed time keeps rolling. This keeps
  // the UI visibly alive during long model thinking / blocked tool runs where
  // otherwise no streamed output is produced (the "looks stuck" problem).
  const setBusyWithHeartbeat = (nextBusy: boolean) => {
    if (nextBusy && !busy) turnStartedAtRef.current = Date.now();
    if (!nextBusy) turnStartedAtRef.current = undefined;
    setBusy(nextBusy);
  };
  useEffect(() => {
    if (!busy) return;
    const heartbeat = setInterval(() => setBusyTick(tick => tick + 1), 1000);
    return () => clearInterval(heartbeat);
  }, [busy]);

  // Refresh the branch at turn boundaries so switching branches during a turn
  // shows up promptly without tight idle polling (CR-026).
  useEffect(() => {
    if (busy) return;
    currentBranchName().then(setBranchName).catch(() => setBranchName(undefined));
  }, [busy]);

  useEffect(() => {
    Promise.all([
      readSettings().then(value => ({value, error: undefined as string | undefined})).catch(error => ({value: {} as HazeSettings, error: error instanceof Error ? error.message : String(error)})),
      currentBranchName().catch(() => undefined),
      readContextFiles().catch(() => [] as ContextFile[]),
    ]).then(([settingsResult, branch, files]) => {
      const next = settingsResult.value;
      setSettings(next);
      setSettingsError(settingsResult.error);
      setBranchName(branch);
      setContextFiles(files);
      contextFileSignaturesRef.current = new Map(files.flatMap(file => file.signature ? [[file.path, file.signature] as const] : []));
      setMessages(m => [...m, {role: 'system', text: settingsResult.error ? settingsResult.error : `${startupProviderInfo(next)}\n\n${startupContextInfo(files)}`}]);
    }).catch(() => undefined);
    sessionLifecycle.initializeSession().catch(error => {
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
            setMessages(m => [...m, {role: 'system', text: `A new version of haze is available: ${result.latestVersion} (you have ${version}). Update with:  npm i -g @denizokcu/haze`}]);
          }
        })
        .catch(() => undefined);
    }
    const branchTimer = setInterval(() => {
      currentBranchName().then(setBranchName).catch(() => setBranchName(undefined));
    }, 15_000);
    return () => clearInterval(branchTimer);
  }, []);

  function persistInputHistory(value: string) {
    addInputHistoryItem(value).then(setInputHistory).catch(() => undefined);
  }

  async function refreshSkills() {
    const registry = await loadSkillRegistry();
    const nextSkills = [...registry.skills.values()];
    setSkills(nextSkills);
    const errorSignature = registry.errors.map(error => `${error.directory}: ${error.message}`).join('\n');
    if (errorSignature && errorSignature !== skillErrorSignatureRef.current) {
      setMessages(messages => [...messages, {role: 'system', text: `Invalid skills were isolated:\n${errorSignature}`}]);
    }
    skillErrorSignatureRef.current = errorSignature;
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

  function showPersistenceWarning(error: unknown) {
    if (persistenceWarningShownRef.current) return;
    persistenceWarningShownRef.current = true;
    const text = error instanceof Error ? error.message : String(error);
    setMessages(messages => [...messages, {role: 'system', text: `Persistence warning: ${text}`}]);
  }

  // Session lifecycle (init/continue/resume/new/clear/compact) lives in a
  // dedicated controller so this component stays orchestration glue (CR-006).
  const sessionLifecycle = createSessionLifecycle({
    version,
    continueSession,
    noSession,
    debug,
    contextFiles: () => contextFiles,
    sessionRef,
    sessionRecorder: () => sessionRecorderRef.current,
    sessionStartRef,
    conversationRef,
    workStateRef,
    lastAssistantTextRef,
    llmLogRef,
    contextFileSignaturesRef,
    setMessages,
    setLiveMessagesState,
    setTokenUsage,
    debugLog,
    showPersistenceWarning,
  });
  const {clearConversation, compactConversation, resumeLatestSession} = sessionLifecycle;

  function cancelThinking() {
    if (!busy) return;
    abortControllerRef.current?.abort('User pressed Esc.');
    if (followUpQueueRef.current.length > 0) {
      followUpQueueRef.current = [];
      setQueuedFollowUps([]);
      setMessages(m => [...m, {role: 'system', text: 'Cleared queued follow-ups after interrupt.'}]);
    }
    setBusyWithHeartbeat(false);
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
      setDiscoveredModels([]);
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

  function showWizardMessage(message: string | undefined) {
    if (message) setMessages(m => [...m, {role: 'system', text: message}]);
  }

  // Wizard/picker submit dispatch lives in one table-driven module with a
  // shared settings-patch applier (CR-006). Rebuilt every render so handlers
  // see current state without new React state.
  const wizard = createWizardDispatch({
    settings, skills, modelProviderFilter, selectedProviderName, selectedSkillName, selectedLspName, selectedMcpName,
    providerDraft, lspDraft, mcpDraft, skillDraft,
    setMode, setSettings,
    setSelectedProviderName, setSelectedSkillName, setSelectedLspName, setSelectedMcpName,
    setModelProviderFilter, setProviderDraft, setSkillDraft, setLspDraft, setMcpDraft, setDiscoveredModels,
    showMessage: showWizardMessage, refreshSkills,
    setBusyLabel, setBusy: setBusyWithHeartbeat,
    idleBusyLabel: thinkingLabelForSettings(settings),
  });

  async function submit(value: string) {
    if (settingsError) {
      try {
        const repaired = await readSettings();
        setSettings(repaired);
        setSettingsError(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setSettingsError(message);
        if (!/^\/(?:settings\s+(?:open|edit)|help|exit|quit)\b/i.test(value.trim())) {
          setMessages(messages => [...messages, {role: 'system', text: `${message}\nRepair settings, then retry. /settings open, /help, and /exit remain available.`}]);
          return;
        }
      }
    }
    if (busy) {
      if (mode === 'chat') queueFollowUp(value);
      return;
    }

    const providerEffects = transitionProviderField({mode, value, settings, draft: providerDraft});
    if (providerEffects) {
      for (const effect of providerEffects) {
        if (effect.type === 'message') showWizardMessage(effect.text);
        else if (effect.type === 'mode') setMode(effect.mode);
        else if (effect.type === 'provider-draft') {
          if (effect.replace) setProviderDraft(effect.patch);
          else setProviderDraft(draft => ({...draft, ...effect.patch}));
        } else if (effect.type === 'discover-provider-models') {
          // The draft patch above is still pending React state, so discovery
          // receives the merged draft explicitly (same pattern as MCP stdio).
          await wizard.discoverProviderModelsForDraft(effect.draft);
        }
      }
      return;
    }

    const mcpEffects = transitionMcpField({mode, value, settings, draft: mcpDraft});
    if (mcpEffects) {
      for (const effect of mcpEffects) {
        if (effect.type === 'message') showWizardMessage(effect.text);
        else if (effect.type === 'mode') setMode(effect.mode);
        else if (effect.type === 'mcp-draft') setMcpDraft(draft => ({...draft, ...effect.patch}));
        else if (effect.type === 'finish-mcp-stdio') await wizard.finishMcpCustom(undefined, effect.draft);
      }
      return;
    }

    if (await wizard.dispatch(mode, value)) return;

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
        await sessionLifecycle.startNewSession('Started a new session.');
      },
      resumeSession: resumeLatestSession,
      sessionInfo: () => sessionRef.current ? formatSession(sessionRef.current) : 'Session persistence is off.',
      compactConversation,
      runAgentTurn: (prompt, displayValue, options) => doAgentTurn(prompt, displayValue, options),
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
      getContextReport: () => buildContextReport({sessionStart: sessionStartRef.current, contextFiles, conversation: conversationRef.current}),
    };
    let result;
    try {
      result = await handleSlashCommand(value, ctx);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessages(m => [...m, {role: 'system', text: `Command failed: ${text}`}]);
      return;
    }
    if (result === 'exit') {
      await sessionRecorderRef.current?.flush().catch(showPersistenceWarning);
      if (llmLogRef.current) await endLlmLog(llmLogRef.current).catch(showPersistenceWarning);
      return exit();
    }
    if (result === 'handled') {
      if (value === '/clear') {
        loadTasksFromStore().then(t => { setVisibleTasks(t); setTaskBarPadding(0); }).catch(() => undefined);
      }
      return;
    }

    await doAgentTurn(value);
  }

  async function doAgentTurn(value: string, displayValue?: string, turnOptions: import('./streaming.js').TurnExecutionOptions = {}) {
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
    await runSingleAgentTurn(value, displayValue, turnOptions);
    while (followUpQueueRef.current.length > 0) {
      const next = followUpQueueRef.current[0];
      followUpQueueRef.current = followUpQueueRef.current.slice(1);
      setQueuedFollowUps(followUpQueueRef.current);
      setMessages(m => [...m, {role: 'system', text: `Running queued follow-up: ${next}`}]);
      await runSingleAgentTurn(next);
    }
  }

  async function runSingleAgentTurn(value: string, displayValue?: string, turnOptions: import('./streaming.js').TurnExecutionOptions = {}) {
    const sessionRecorder = sessionRecorderRef.current!;
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
      setBusy: setBusyWithHeartbeat,
      setBusyLabel,
      debugLog,
      getConversation: () => conversationRef.current,
      getLastAssistantText: () => lastAssistantTextRef.current,
      setLastAssistantText: text => { lastAssistantTextRef.current = text; },
      setAbortController: controller => { abortControllerRef.current = controller; },
      setWorkState: state => {
        workStateRef.current = state;
        sessionRecorder.recordWorkState(state);
      },
      compactConversation,
      recordTokenUsage: usage => {
        setTokenUsage(current => accumulateTokenUsage(current, usage));
      },
      onEvent: event => {
        sessionRecorder.recordEvent(event);
      },
      onTasksChanged: () => { loadTasksFromStore().then(t => { setVisibleTasks(t); setTaskBarPadding(0); }).catch(() => undefined); },
      contextFileSignatures: contextFileSignaturesRef.current,
      log: llmLogRef.current,
    }, 0, false, false, {start: sessionStartRef.current, cwd: process.cwd()}, undefined, turnOptions);
    await sessionRecorder.flush().catch(showPersistenceWarning);
    await llmLogRef.current?.writer?.flush().catch(showPersistenceWarning);
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
    'Start with simple chat, then teach haze your habits with skills:',
    '/skills  — add, enable/disable, validate, or remove Markdown skills.',
    '',
    'The most adaptive workflow is the one you shape as you go.',
    '',
    'Guardrails are light: haze lets the LLM work from the terminal almost like you,',
    'while trying to stay scoped to this project.',
  ].join('\n');
  const workspaceLabel = `${compactHomePath(process.cwd())}${branchName ? ` (${branchName})` : ''}`;
  const enabledSkillCount = skills.filter(skill => isSkillEnabled(settings, skill.name)).length;
  const metrics = statusBarMetrics({messages: [...messages, ...liveMessages], tokenUsage, enabledSkillCount});
  const inputSuggestions = inputSuggestionsForState({mode, settings, skills, selectedProviderName, modelProviderFilter, providerDraftName: providerDraft.name, discoveredModels, selectedSkillName, selectedLspName, selectedMcpName});
  const staticItems = [
    {kind: 'header' as const, key: `header-${activeModelName}`, subtitle: headerSubtitle},
    ...transcriptItems.map(item => ({kind: 'message' as const, ...item})),
  ];
  const busyElapsed = busyElapsedLabel(turnStartedAtRef.current);

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
      <Text><Text color={theme.orange} bold><Spinner type="dots" /> {busyLabel}{busyElapsed ? <Text color={theme.muted} dimColor> · {busyElapsed}</Text> : null}</Text><Text color={theme.muted} dimColor> · type to queue follow-up · esc to interrupt</Text></Text>
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
    {debug && metrics.hasTokenBreakdown && <Box flexShrink={0} flexDirection="column" paddingX={1}>
      <Text color={theme.muted} bold>Token usage {metrics.inputEstimated || metrics.outputEstimated ? '(estimated)' : '(precise)'}</Text>
      <Text color={theme.muted}>  in={formatTokenCount(metrics.effectiveInput)} out={formatTokenCount(metrics.effectiveOutput)}{tokenUsage.cacheReadTokens > 0 ? ` cached=${formatTokenCount(tokenUsage.cacheReadTokens)}` : ''}{tokenUsage.noCacheTokens > 0 ? ` uncached=${formatTokenCount(tokenUsage.noCacheTokens)}` : ''}{tokenUsage.cacheWriteTokens > 0 ? ` cache_write=${formatTokenCount(tokenUsage.cacheWriteTokens)}` : ''}{tokenUsage.reasoningTokens > 0 ? ` reasoning=${formatTokenCount(tokenUsage.reasoningTokens)}` : ''}</Text>
      <Text color={theme.muted}>  logical={formatTokenCount(tokenUsage.logicalInputEstimate)}{tokenUsage.effectiveNonCachedInput != null ? ` effective_non_cached=${formatTokenCount(tokenUsage.effectiveNonCachedInput)}` : ''}</Text>
      <Text color={theme.muted}>  system={formatTokenCount(tokenUsage.systemPrompt)} messages={formatTokenCount(tokenUsage.messages)} tools={formatTokenCount(tokenUsage.toolSchemas)} output={formatTokenCount(tokenUsage.outputEstimate)}</Text>
    </Box>}
    <Box flexShrink={0} justifyContent="space-between">
      <Box flexDirection="column" flexShrink={1} minWidth={0}>
        <Text color={theme.muted} dimColor wrap="truncate-end">{workspaceLabel}</Text>
        <Text color={theme.muted} dimColor wrap="truncate-end">{metrics.statusDetailLabel}</Text>
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
