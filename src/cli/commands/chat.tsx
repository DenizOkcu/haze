import React, {useEffect, useMemo, useReducer, useRef, useState} from 'react';
import {render, Text, useApp, useWindowSize} from 'ink';
import {type ModelMessage} from 'ai';
import type {PromptSession} from '../../llm/systemPrompt.js';
import type {ContextFile} from '../../config/contextFiles.js';
import {addInputHistoryItem, readInputHistory} from '../../config/inputHistory.js';
import {loadTasks as loadTasksFromStore, clearTasks as clearTasksFromStore} from '../../core/tasks/taskStorage.js';
import type {Task} from '../../core/tasks/taskStorage.js';
import {readSettings, type HazeSettings} from '../../config/settings.js';
import {activeModel, providerEndpointFingerprint} from '../../config/providers.js';
import {isSkillEnabled} from '../../config/skillSettings.js';
import {setActiveTheme, resolveTheme, theme, DEFAULT_THEME_NAME} from '../../ui/theme.js';
import {applyTerminalColors, resetTerminalColors} from '../../ui/terminalColors.js';
import {checkpointFromGoalFrontier} from './streaming/goalCheckpoint.js';
import {finalizeMessage as finalizeMessageImpl} from '../chat/messageFinalize.js';
import {submit as submitImpl} from '../chat/submitPipeline.js';
import {runSingleAgentTurn as runSingleAgentTurnImpl} from '../chat/agentTurnRunner.js';
import type {ChatScreenDeps, PausedResume, ResumeExisting} from '../chat/screenDeps.js';
import {type Message} from './streaming.js';
import type {TokenUsage} from './streaming/turnRuntime.js';
import {type LlmLog, endLog as endLlmLog} from '../../core/log/llmLog.js';
import {loadSkillRegistry} from '../../skills/SkillRegistry.js';
import type {LoadedSkill} from '../../skills/types.js';
import {listSessions, type HazeSession, type SessionSummary} from '../../core/session/sessionStore.js';
import type {WorkState} from '../../core/agent/workState.js';
import {MAX_VISIBLE_TASKS} from '../chat/TaskBar.js';
import {createChatShutdown, runTerminalSession} from '../chat/shutdown.js';
import {installViewportResizeGuard} from '../chat/resizeGuard.js';
import {partitionDisplayMessages} from '../chat/transcriptPartition.js';
import {ChatScreenView, type ChatStaticItem} from '../chat/ChatScreenView.js';
import {useLiveMessages} from '../chat/liveMessages.js';
import {createSessionRecorder, type SessionRecorder} from '../chat/sessionRecorder.js';
import {createSessionLifecycle} from '../chat/sessionLifecycle.js';
import {createWizardDispatch, initialWizardUiState, wizardUiReducer} from '../chat/wizardDispatch.js';
import {randomTipIndex, tipsEnabled} from '../chat/tips.js';
import {busyDetailLabel, compactHomePath, statusBarMetrics, type FleetStatus} from '../chat/chatMetrics.js';
import {EMPTY_TOKEN_USAGE, shouldClearCompletedTasks} from '../chat/turnState.js';
import {placeholderForMode, type Mode} from './chatModes.js';
import {contextFileSignatureMap, mergeSettingsSelection, prepareUserInput as prepareUserInputPolicy, resumeKindFor} from '../chat/userInput.js';
import {isStoredReasoning, resolveReasoningChoice} from '../../core/agent/reasoningPolicy.js';
import {resolveProviderReasoning} from '../../config/providerReasoning.js';
import {inputSuggestionsForState} from '../chat/inputSuggestions.js';
import {currentBranchName, runStartupSequence} from '../chat/startupSequence.js';
import {useFollowUpQueue} from '../chat/followUpQueue.js';
import {useBusyIndicator} from '../chat/busyIndicator.js';
import {useTerminalControl} from '../chat/terminalControl.js';
import {modelThinkingLabel} from '../../utils/modelName.js';
import {transitionProviderConversation} from '../../core/agent/providerTransition.js';
import {commandParts} from './wizardFlow.js';
import {backgroundProcessCount, subscribeBackgroundProcesses, teardownBackgroundProcesses} from '../../core/process/backgroundRegistry.js';
import {MAX_SESSION_PICKER_RESULTS} from './sessionPicker.js';
import {listInstalledPlugins} from './pluginCommand.js';

interface ChatOptions {
  debug?: boolean;
  version?: string;
  /** Safe build provenance (commit, build time) recorded into session headers. */
  build?: {commit?: string; builtAt?: string};
  continueSession?: boolean;
  resumeSessionId?: string;
  noSession?: boolean;
}

/** Latest Ink render metrics under --debug (module-level: render options are outside React). */
let renderMetricsReader: (() => {at: number; renderTime: number} | undefined) | undefined;

function thinkingLabelForSettings(settings: HazeSettings) {
  return modelThinkingLabel(activeModel(settings)?.model);
}

function ChatScreen({debug = false, version, build, continueSession = false, resumeSessionId, noSession = false, onShutdownReady}: ChatOptions & {onShutdownReady?: (shutdown: () => Promise<void>) => void}) {
  const {exit} = useApp();
  const {columns: width, rows: terminalRows} = useWindowSize();
  const stoppingRef = useRef(false);
  const sealedRef = useRef(false);
  const activeGoalRef = useRef<Promise<unknown> | undefined>(undefined);
  const quarantineRef = useRef<(() => void) | undefined>(undefined);
  const nextDisplayOrderRef = useRef(1);
  const withDisplayOrder = (message: Message): Message => {
    if (message.displayOrder != null) return message;
    return {...message, displayOrder: nextDisplayOrderRef.current++};
  };
  const withDisplayOrders = (next: Message[]) => next.map(withDisplayOrder);
  const [messages, setMessagesRaw] = useState<Message[]>([]);
  const setMessages = (updater: React.SetStateAction<Message[]>) => {
    if (stoppingRef.current) return;
    setMessagesRaw(previous => withDisplayOrders(typeof updater === 'function' ? updater(previous) : updater));
  };
  const [settings, setSettingsRaw] = useState<HazeSettings>({});
  const settingsRef = useRef<HazeSettings>({});
  const defaultSelectionRef = useRef<{provider?: string; model?: string}>({});
  function setSettings(next: HazeSettings, patch?: HazeSettings) {
    const previousSelection = currentModelSelection();
    const previousProvider = activeModel(settingsRef.current)?.provider;
    // The ref records the global default from `next` (what updateSettings
    // returned) before the patch merge; unrelated settings writes must not
    // replace a resumed session's model (merge policy in chat/userInput.ts).
    defaultSelectionRef.current = {provider: next.provider, model: next.model};
    settingsRef.current = patch ? mergeSettingsSelection(next, settingsRef.current, patch) : next;
    const selected = currentModelSelection();
    const selectedProvider = activeModel(settingsRef.current)?.provider;
    const changedEndpoint = selectedProvider && (!previousProvider || previousProvider.url !== selectedProvider.url || previousProvider.kind !== selectedProvider.kind);
    if (patch && previousSelection && selected && (previousSelection.provider !== selected.provider || previousSelection.model !== selected.model || changedEndpoint) && conversationRef.current.length) {
      conversationRef.current = transitionProviderConversation(conversationRef.current);
      sessionRecorderRef.current?.recordModelTransition(conversationRef.current, selected);
      setMessages(messages => [...messages, {role: 'system', text: 'Model changed: previous tool history was converted to text and provider reasoning state was cleared.'}]);
    }
    setSettingsRaw(settingsRef.current);
    if (patch && ('provider' in patch || 'model' in patch)) {
      if (selected) sessionRecorderRef.current?.recordModelSelection(selected);
    }
  }
  function currentModelSelection() {
    const {provider, model} = settingsRef.current;
    const selected = activeModel(settingsRef.current);
    return provider && model ? {provider, model, ...(selected ? {endpointFingerprint: providerEndpointFingerprint(selected.provider)} : {})} : undefined;
  }
  const [settingsError, setSettingsError] = useState<string | undefined>();
  const conversationRef = useRef<ModelMessage[]>([]);
  const lastAssistantTextRef = useRef('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<HazeSession | undefined>(undefined);
  const sessionRecorderRef = useRef<SessionRecorder | undefined>(undefined);
  if (!sessionRecorderRef.current) sessionRecorderRef.current = createSessionRecorder(() => sessionRef.current);

  /** Finalize a formerly-live message into the append-only transcript and session record. */
  function finalizeMessage(message: Message) {
    finalizeMessageImpl(screenDeps(), message);
  }

  // Synchronous live-tail store (see chat/liveMessages.ts): stream callbacks
  // that land inside one React batch window must route against fresh state.
  const {liveMessages, addStreaming, patch: patchLiveMessage, drain: drainLiveMessages, clear: clearLiveMessages} = useLiveMessages(finalizeMessage);
  const sessionStartRef = useRef<Date>(new Date());
  // Stable PromptSession object across turns so per-session flags (the
  // context-fallback warning key) persist; rebuilt when a new session starts,
  // detected by sessionStartRef identity (the lifecycle controller replaces
  // the Date on new/resume/continue).
  const promptSessionRef = useRef<{identity: Date | undefined; value: PromptSession}>({identity: undefined, value: {cwd: process.cwd()}});
  // Session per-model reasoning overrides live on the stable PromptSession
  // object; this counter only forces a re-render so the status bar updates.
  const [reasoningOverrideCounter, setReasoningOverrideCounter] = useState(0);
  const workStateRef = useRef<WorkState | undefined>(undefined);
  const llmLogRef = useRef<LlmLog | undefined>(undefined);
  const persistenceWarningShownRef = useRef(false);
  const skillErrorSignatureRef = useRef('');
  const skillNoticeSignatureRef = useRef('');
  const projectSkillSignatureRef = useRef('');
  const contextFileSignaturesRef = useRef<Map<string, string>>(new Map());
  const followUps = useFollowUpQueue(text => setMessages(m => [...m, {role: 'system', text}]));
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  const [mode, setMode] = useState<Mode>('chat');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  // Busy indicator with a one-second heartbeat: ticks while haze is working so
  // the developer always sees rolling activity (elapsed turn time) even when
  // the model is thinking with no streamed output and no tool is running.
  const {busy, setBusy: setBusyWithHeartbeat, elapsed: busyElapsed} = useBusyIndicator();
  // Fleet depth for the busy row; folded from coordinator events so a
  // minutes-long fan-out turn visibly progresses (workers running/queued).
  const [fleet, setFleet] = useState<FleetStatus | undefined>(undefined);
  const terminalControl = useTerminalControl();
  const [backgroundCount, setBackgroundCount] = useState(backgroundProcessCount);
  const [busyLabel, setBusyLabel] = useState(() => thinkingLabelForSettings(settings));
  const [visibleTasks, setVisibleTasks] = useState<Task[]>([]);
  const [tasksExpanded, setTasksExpanded] = useState(false);
  const [taskBarPadding, setTaskBarPadding] = useState(0);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>({...EMPTY_TOKEN_USAGE});
  // A genuinely paused goal (no measurable progress, deadline, or a stalled
  // model stream) — automatic continuation has already been attempted by the
  // goal supervisor. Carries what a one-key resume needs; any new submission
  // clears it.
  const [pausedResume, setPausedResume] = useState<PausedResume | undefined>(undefined);
  const [skills, setSkills] = useState<LoadedSkill[]>([]);
  const [branchName, setBranchName] = useState<string | undefined>();
  const [graphBuilding, setGraphBuilding] = useState(false);
  const shutdownRef = useRef<(() => Promise<void>) | undefined>(undefined);
  if (!shutdownRef.current) shutdownRef.current = createChatShutdown({
    stop: () => { stoppingRef.current = true; followUps.clear(); },
    abort: () => abortControllerRef.current?.abort('Chat is exiting.'),
    settle: () => activeGoalRef.current,
    seal: () => {
      drainLiveMessages();
      sealedRef.current = true;
      quarantineRef.current?.();
    },
    flush: () => sessionRecorderRef.current?.flush(),
    endLog: () => {
      const log = llmLogRef.current;
      llmLogRef.current = undefined;
      return log ? endLlmLog(log) : undefined;
    },
    cleanup: async () => {
      await Promise.all([teardownBackgroundProcesses(), clearTasksFromStore()]);
    },
    exit,
    report: message => process.stderr.write(`[haze] ${message}\n`),
  });
  const shutdown = shutdownRef.current;
  useEffect(() => {
    onShutdownReady?.(shutdown);
    return () => { void shutdown(); };
  }, [onShutdownReady, shutdown]);

  // Wizard flow state (selection, drafts, model discovery) in one reducer;
  // this replaced twelve individual useState hooks.
  const [wizardState, updateWizard] = useReducer(wizardUiReducer, undefined, initialWizardUiState);
  const {modelProviderFilter, discoveredModels, suggestedModels, selectedProviderName, providerDraft, selectedSkillName, selectedLspName, selectedMcpName, plugins, selectedPluginName, pluginCollectionEntries} = wizardState;

  useEffect(() => subscribeBackgroundProcesses(() => setBackgroundCount(backgroundProcessCount())), []);

  // One tip per thinking section, shown under the busy label while the model
  // is purely thinking (no tool running) and the user has not disabled tips.
  // A fresh tip is picked each time the model enters thinking mode; no
  // rotation during a single thinking section.
  const [tipIndex, setTipIndex] = useState(() => randomTipIndex());
  const thinkingLabel = thinkingLabelForSettings(settings);
  const showingTip = busy && busyLabel === thinkingLabel && tipsEnabled(settings);
  useEffect(() => {
    if (!showingTip) return;
    setTipIndex(current => randomTipIndex(current));
  }, [showingTip]);

  // Refresh the branch at turn boundaries so switching branches during a turn
  // shows up promptly without tight idle polling (CR-026).
  useEffect(() => {
    if (busy) return;
    currentBranchName().then(setBranchName).catch(() => setBranchName(undefined));
  }, [busy]);

  // Live theme switching: whenever the settings'
  // theme name changes (/themes), re-resolve and adopt it so the whole UI
  // repaints without a restart. Ink <Static> history stays as-rendered, so
  // already-printed text keeps its old colors; the terminal defaults (OSC
  // 10/11) follow the new theme. Skipped until settings have loaded once —
  // chatCommand() already resolved the theme before the first render, and the
  // pre-load {} state would briefly flash the default theme.
  const settingsThemeLoadedRef = useRef(false);
  const activeThemeName = settings.theme ?? DEFAULT_THEME_NAME;
  useEffect(() => {
    if (!settingsThemeLoadedRef.current || stoppingRef.current) return;
    try {
      setActiveTheme(resolveTheme(activeThemeName));
      applyTerminalColors(theme.foreground, theme.background);
    } catch {
      // Malformed theme names were reported at startup; keep the resolved default.
    }
  }, [activeThemeName]);

  useEffect(() => {
    void runStartupSequence({
      version,
      onLoaded({settings: next, settingsError, branchName: branch, contextFiles: files}) {
        setSettings(next);
        settingsThemeLoadedRef.current = true;
        setSettingsError(settingsError);
        setBranchName(branch);
        setContextFiles(files);
        contextFileSignaturesRef.current = contextFileSignatureMap(files);
      },
      initializeSession: () => sessionLifecycle.initializeSession(),
      refreshSkills,
      addSystemMessage: text => setMessages(m => [...m, {role: 'system', text}]),
      onGraphActivity: setGraphBuilding,
    }).catch(() => undefined);
    readInputHistory().then(setInputHistory).catch(() => undefined);
    loadTasksFromStore().then(setVisibleTasks).catch(() => undefined);
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
    const nextSkills = registry.candidates ?? [...registry.skills.values()];
    setSkills(nextSkills);
    const projectSkills = nextSkills.filter(skill => skill.source === 'project');
    const projectSignature = projectSkills.map(skill => `${skill.name}:${skill.path}`).join('\n');
    if (projectSignature && projectSignature !== projectSkillSignatureRef.current) {
      setMessages(messages => [...messages, {role: 'system', text: `Project skills discovered (repository-provided, untrusted content): ${projectSkills.map(skill => skill.name).join(', ')}`}]);
    }
    projectSkillSignatureRef.current = projectSignature;
    const errorSignature = registry.errors.map(error => `${error.source ? `${error.source}/` : ''}${error.directory}: ${error.message}`).join('\n');
    if (errorSignature && errorSignature !== skillErrorSignatureRef.current) {
      setMessages(messages => [...messages, {role: 'system', text: `Invalid skills were isolated:\n${errorSignature}`}]);
    }
    skillErrorSignatureRef.current = errorSignature;
    // Visible load-time shadow notices (HZA-6): a project skill silently
    // overriding a same-named user skill is something the user should see.
    const noticeSignature = (registry.notices ?? []).join('\n');
    if (noticeSignature && noticeSignature !== skillNoticeSignatureRef.current) {
      setMessages(messages => [...messages, {role: 'system', text: noticeSignature}]);
    }
    skillNoticeSignatureRef.current = noticeSignature;
    return nextSkills;
  }

  function skillInvocation(value: string) {
    if (!value.startsWith('/')) return undefined;
    const [name, ...args] = commandParts(value.slice(1));
    if (!name) return undefined;
    const skill = skills.find(candidate => candidate.name === name && isSkillEnabled(settings, candidate.name, candidate.source));
    // Candidates are ordered project-first, so disabling a project collision
    // automatically re-surfaces the enabled global skill.
    return skill ? {skill, args: args.join(' ')} : undefined;
  }

  function debugLog(line: string) {
    if (!debug || stoppingRef.current) return;
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
    build,
    continueSession,
    resumeSessionId,
    noSession,
    debug,
    contextFiles: () => contextFiles,
    modelSelection: currentModelSelection,
    reasoningByModel: () => currentPromptSession().reasoningByModel,
    onModelSelection: selection => {
      const model = selection ? {provider: selection.provider, model: selection.model} : defaultSelectionRef.current;
      settingsRef.current = {...settingsRef.current, ...model};
      setSettingsRaw(settingsRef.current);
    },
    sessionRef,
    sessionRecorder: () => sessionRecorderRef.current,
    sessionStartRef,
    conversationRef,
    workStateRef,
    lastAssistantTextRef,
    llmLogRef,
    contextFileSignaturesRef,
    setMessages,
    clearLiveMessages,
    setTokenUsage,
    manualCompaction: () => settings.manualCompaction ?? 'llm-summary',
    redactSessionSecrets: () => settings.redactSessionSecrets === true,
    // P1 resume path: an unterminated goal frontier detected on resume becomes
    // the same one-key continue affordance the in-process pause uses — the
    // goal continues from the stored frontier without re-sending the request.
    onGoalFrontier: frontier => {
      const checkpoint = checkpointFromGoalFrontier(frontier);
      setPausedResume({kind: 'incomplete-goal', request: frontier.request, retryAttempt: 0, checkpoint});
      setMessages(m => [...m, {role: 'system', text: `This session ended with an unfinished goal (cycle ${frontier.cycle}, ${frontier.mutationCount} change${frontier.mutationCount === 1 ? '' : 's'} so far). Press R to resume it from where it stopped.`}]);
    },
    debugLog,
    showPersistenceWarning,
  });
  async function openSessionPicker() {
    await sessionRecorderRef.current?.flush().catch(showPersistenceWarning);
    const next = await listSessions();
    setSessions(next);
    updateWizard({type: 'set', key: 'selectedSessionId', value: undefined});
    if (next.length === 0) {
      setMessages(m => [...m, {role: 'system', text: 'No saved sessions found for this workspace.'}]);
      setMode('chat');
      return;
    }
    setMode('sessions');
    const hidden = Math.max(0, next.length - MAX_SESSION_PICKER_RESULTS);
    setMessages(m => [...m, {role: 'system', text: `Choose a saved session (newest first)${hidden ? `. Showing ${MAX_SESSION_PICKER_RESULTS} of ${next.length}; ${hidden} older sessions are hidden.` : '.'}`}]);
  }

  async function openPluginPicker() {
    try {
      updateWizard({type: 'plugins', value: await listInstalledPlugins()});
    } catch (error) {
      setMessages(m => [...m, {role: 'system', text: `Could not list installed plugins: ${error instanceof Error ? error.message : String(error)}`}]);
      return;
    }
    setMode('plugins');
    setMessages(m => [...m, {role: 'system', text: 'Choose install plugin, inspect plugin, or an installed plugin to manage. Only skills activate; no scripts, hooks, or MCP servers run.'}]);
  }

  function cancelThinking() {
    if (!busy) return;
    abortControllerRef.current?.abort('User pressed Esc.');
    followUps.clear();
    setBusyWithHeartbeat(false);
  }

  function closeInputList() {
    if (mode !== 'chat') {
      setMode('chat');
      setSessions([]);
      updateWizard({type: 'reset'});
    }
  }

  function showWizardMessage(message: string | undefined) {
    if (message) setMessages(m => [...m, {role: 'system', text: message}]);
  }

  // Session per-model reasoning overrides live on the stable PromptSession
  // object; the counter only forces a re-render so the status bar updates.
  function setSessionReasoningOverride(modelSelector: string, setting: import('../../core/agent/reasoningPolicy.js').StoredReasoningSetting | undefined) {
    const session = currentPromptSession();
    if (setting === undefined) {
      if (session.reasoningByModel) delete session.reasoningByModel[modelSelector];
    } else {
      session.reasoningByModel = {...session.reasoningByModel, [modelSelector]: setting};
    }
    setReasoningOverrideCounter(count => count + 1);
  }

  // Wizard/picker submit dispatch lives in one table-driven module with a
  // shared settings-patch applier (CR-006). Rebuilt every render so handlers
  // see current state without new React state.
  const wizard = createWizardDispatch({
    settings, skills, sessions,
    wizard: wizardState, updateWizard,
    setMode, setSettings,
    showMessage: showWizardMessage, refreshSkills,
    resumeSessionById: sessionLifecycle.resumeSessionById,
    forkSessionById: sessionLifecycle.forkSessionById,
    setBusyLabel, setBusy: setBusyWithHeartbeat,
    idleBusyLabel: thinkingLabelForSettings(settings),
    sessionReasoning: {
      modelSelector: () => { const selection = activeModel(settings); return selection ? `${selection.provider.name}:${selection.model}` : undefined; },
      get: modelSelector => currentPromptSession().reasoningByModel?.[modelSelector],
      set: setSessionReasoningOverride,
    },
  });

  // The submit pipeline (exit shortcut, settings repair, busy queue, wizard,
  // skill invocation, slash commands, agent turn) lives in chat/submitPipeline.ts.
  async function submit(value: string) {
    return submitImpl(screenDeps(), value);
  }

  // F03: attachment gating and read blessings live in the pure helper
  // (chat/userInput.ts); this wrapper only surfaces its errors as system
  // messages. Applied only to genuine user input, never synthetic control prompts.
  async function prepareUserInput(value: string): Promise<{value: string; displayValue?: string; options: import('./streaming.js').TurnExecutionOptions} | undefined> {
    const prepared = await prepareUserInputPolicy(value, settings);
    if (prepared?.error) {
      setMessages(m => [...m, {role: 'system', text: prepared.error!}]);
      return undefined;
    }
    return prepared;
  }

  async function doAgentTurn(value: string, displayValue?: string, turnOptions: import('./streaming.js').TurnExecutionOptions = {}) {
    if (stoppingRef.current) return;
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
    for (let next = followUps.takeNext(); !stoppingRef.current && next !== undefined; next = followUps.takeNext()) {
      const preparedFollowUp = await prepareUserInput(next);
      if (!preparedFollowUp) continue;
      await runSingleAgentTurn(preparedFollowUp.value, preparedFollowUp.displayValue, preparedFollowUp.options);
    }
  }

  /**
   * Explicitly resume a genuinely paused goal (automatic continuation already
   * ran): an idle-stall resume continues the bounded retry pool; an
   * incomplete-goal resume restarts the supervisor from the stored checkpoint
   * (kind selection in chat/userInput.ts). Both ride the preserved
   * conversation — no completed mutations are replayed.
   */
  async function resumePausedTask() {
    const resume = pausedResume;
    if (!resume || busy) return;
    setPausedResume(undefined);
    setMessages(m => [...m, {role: 'system', text: 'Resuming the unfinished goal; completed work is preserved in the conversation.'}]);
    await runSingleAgentTurn(resume.request, undefined, {}, resumeKindFor(resume) as ResumeExisting);
  }

  /**
   * The PromptSession shared by every turn of the active session. Returning a
   * stable object (not a fresh literal per turn) is what makes once-per-session
   * affordances actually once-per-session; a new session identity yields a
   * fresh object so they fire again at its start.
   */
  function currentPromptSession(): PromptSession {
    if (promptSessionRef.current.identity !== sessionStartRef.current) {
      promptSessionRef.current = {identity: sessionStartRef.current, value: {start: sessionStartRef.current, cwd: process.cwd()}};
    }
    return promptSessionRef.current.value;
  }

  /** Assemble the explicit deps bundle the extracted chat.tsx bodies receive. */
  function screenDeps(): ChatScreenDeps {
    return {
      stoppingRef, sealedRef, quarantineRef, activeGoalRef, conversationRef, settingsRef,
      sessionRef, sessionRecorderRef, sessionStartRef, workStateRef, lastAssistantTextRef,
      abortControllerRef, llmLogRef, contextFileSignaturesRef,
      settings, settingsError, contextFiles, mode, busy, pausedResume, visibleTasks,
      setMessages, setSettings, setSettingsError, setMode, setContextFiles,
      setBusy: setBusyWithHeartbeat, setBusyLabel, setTokenUsage, setFleet,
      setVisibleTasks, setTaskBarPadding, setTasksExpanded, setPausedResume, updateWizard,
      currentModelSelection, currentPromptSession, withDisplayOrder, finalizeMessage,
      addStreaming, patchLiveMessage, drainLiveMessages, clearLiveMessages,
      debugLog, showPersistenceWarning, skillInvocation, prepareUserInput, doAgentTurn,
      openSessionPicker, openPluginPicker, refreshSkills, setSessionReasoningOverride,
      shutdown, followUps, wizard, sessionLifecycle, terminalControl, noSession,
    };
  }

  // One physical agent turn under the goal supervisor lives in chat/agentTurnRunner.ts.
  async function runSingleAgentTurn(value: string, displayValue?: string, turnOptions: import('./streaming.js').TurnExecutionOptions = {}, resumeExisting?: ResumeExisting) {
    return runSingleAgentTurnImpl(screenDeps(), value, displayValue, turnOptions, resumeExisting);
  }

  // The heavy per-render work below is memoised on the identity of its inputs
  // (FE-03): the 1 Hz busy heartbeat and every stream delta re-render the
  // screen, but only changed messages may re-run Markdown root chunking.
  const activeLiveMessages = useMemo(() => liveMessages.filter(message => !message.hidden), [liveMessages]);
  // Recomputed each busy heartbeat (1 Hz) alongside the elapsed label; the
  // streaming-rate estimate rides the already-live message text, so no extra
  // timer or token bookkeeping is introduced.
  const busyDetail = busy ? busyDetailLabel({messages: activeLiveMessages, fleet}) : undefined;
  const {staticItems: staticTranscriptItems, streamingItems} = useMemo(
    () => partitionDisplayMessages([...messages, ...liveMessages].filter(message => !message.hidden)),
    [messages, liveMessages]);
  const activeSelection = activeModel(settings);
  const placeholder = placeholderForMode(mode, busy);
  const selectedModel = currentModelSelection();
  const activeModelName = selectedModel ? `${selectedModel.provider}:${selectedModel.model}${activeSelection ? '' : ' (unavailable)'}` : 'unconfigured';
  const activeSelector = activeSelection ? `${activeSelection.provider.name}:${activeSelection.model}` : undefined;
  // Synchronize session identity before rendering either the status or picker;
  // a new/resumed/forked session must not display the previous session's map.
  const sessionReasoning = currentPromptSession().reasoningByModel;
  const effectiveReasoning = activeSelector
    ? resolveReasoningChoice(sessionReasoning?.[activeSelector], isStoredReasoning(settings.reasoning) ? settings.reasoning : undefined)
    : undefined;
  // When a session override changes, the suffix below must re-render: bump a
  // cheap counter from setSessionReasoning instead of threading per-turn state.
  void reasoningOverrideCounter;
  const reasoningSuffix = effectiveReasoning
    ? effectiveReasoning.level === undefined
      ? ' (no reasoning parameter)'
      : activeSelection && resolveProviderReasoning(activeSelection.provider, activeSelection.model, effectiveReasoning.level).effective === 'disabled'
        ? ' (provider default)'
      : ` (${effectiveReasoning.level})`
    : '';
  const headerSubtitle = (
    <Text>
      {'A minimal coding agent for your terminal.\n\nStart with chat. Turn repeated work into Markdown skills:\n'}
      <Text color={theme.command}>/skills</Text>
      {'  — create, enable, disable, validate, or remove skills.\n\nType '}
      <Text color={theme.command}>@</Text>
      {' to browse workspace files. To grant read-only access to a file or directory outside the workspace for this turn, mention a path containing '}
      <Text color={theme.command}>/</Text>
      {' (for example, '}
      <Text color={theme.command}>@../shared/file.ts</Text>
      {' or '}
      <Text color={theme.command}>/tmp/reference.md</Text>
      {').\n\nImage mentions require a vision-capable model. File edits and writes stay inside the workspace.\n\nhaze runs tool calls without confirmation gates. Supervise consequential work as you would any shell session.\n\nShape haze around your workflow as you go.\n\nUse '}
      <Text color={theme.command}>/help</Text>
      {' for commands.'}
    </Text>
  );
  const workspaceLabel = `${compactHomePath(process.cwd())}${branchName ? ` (${branchName})` : ''}`;
  const enabledSkillCount = useMemo(
    () => new Set(skills.filter(skill => isSkillEnabled(settings, skill.name, skill.source)).map(skill => skill.name)).size,
    [skills, settings]);
  const metrics = useMemo(
    () => statusBarMetrics({messages: [...messages, ...liveMessages], tokenUsage, enabledSkillCount, backgroundProcessCount: backgroundCount}),
    [messages, liveMessages, tokenUsage, enabledSkillCount, backgroundCount]);
  const inputSuggestions = useMemo(
    () => inputSuggestionsForState({mode, settings, skills, sessions, selectedProviderName, modelProviderFilter, providerDraftName: providerDraft.name, discoveredModels, suggestedModels, selectedSkillName, selectedLspName, selectedMcpName, plugins, selectedPluginName, pluginCollectionEntries, sessionReasoning}),
    [mode, settings, skills, sessions, selectedProviderName, modelProviderFilter, providerDraft.name, discoveredModels, suggestedModels, selectedSkillName, selectedLspName, selectedMcpName, plugins, selectedPluginName, pluginCollectionEntries, sessionReasoning]);
  const staticItems: ChatStaticItem[] = [
    {kind: 'header', key: 'header', subtitle: headerSubtitle},
    ...staticTranscriptItems,
  ];
  const horizontalPadding = width >= 12 ? 1 : 0;
  const contentWidth = Math.max(1, width - horizontalPadding * 2);

  // The pure screen render (static transcript + dynamic frame) lives in chat/ChatScreenView.tsx.
  return <ChatScreenView
    version={version} debug={debug} width={width} terminalRows={terminalRows}
    horizontalPadding={horizontalPadding} contentWidth={contentWidth}
    staticItems={staticItems} streamingItems={streamingItems}
    debugLogs={debugLogs} metrics={metrics} renderMetricsReader={renderMetricsReader}
    tokenUsage={tokenUsage} followUps={followUps} visibleTasks={visibleTasks}
    tasksExpanded={tasksExpanded} taskBarPadding={taskBarPadding}
    busy={busy} busyLabel={busyLabel} busyElapsed={busyElapsed} busyDetail={busyDetail}
    showingTip={showingTip} tipIndex={tipIndex} graphBuilding={graphBuilding}
    pausedResume={pausedResume} workspaceLabel={workspaceLabel}
    activeModelName={activeModelName} reasoningSuffix={reasoningSuffix}
    placeholder={placeholder} mode={mode} inputHistory={inputHistory}
    inputSuggestions={inputSuggestions}
    onSubmit={submit} onCancel={cancelThinking}
    onResumeKey={pausedResume != null && !busy ? resumePausedTask : undefined}
    onInterrupt={() => { void shutdown(); }}
    onEscape={() => {
      if (busy) cancelThinking();
      else closeInputList();
    }}
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
  />;
}

export async function chatCommand(options: ChatOptions = {}) {
  // Resolve the theme before any Ink output so every component renders with it.
  // Settings failures must not block startup (the in-app banner already reports
  // them), but an unknown theme name fails loudly with the valid names listed.
  try {
    setActiveTheme(resolveTheme((await readSettings()).theme));
  } catch (error) {
    console.error(`[haze] ${error instanceof Error ? error.message : String(error)}; using the ${DEFAULT_THEME_NAME} theme.`);
  }
  await clearTasksFromStore().catch(() => undefined);
  let shutdown: (() => Promise<void>) | undefined;
  // Sampled by the --debug onRender hook; read by ChatScreen's debug panel via
  // a getter so the metric never enters React state (no extra re-renders).
  let lastRenderMetricsMs: {at: number; renderTime: number} | undefined;
  renderMetricsReader = () => lastRenderMetricsMs;
  // Clear on width changes ahead of Ink's repaint; ChatScreen then replays
  // its width-keyed Static transcript instead of leaving a blank viewport.
  const removeResizeGuard = installViewportResizeGuard();
  await runTerminalSession({
    adopt: () => {
      if (!process.stdout.isTTY) return;
      // Clear the viewport, not preexisting terminal scrollback.
      process.stdout.write('\u001B[2J\u001B[H');
      applyTerminalColors(theme.foreground, theme.background);
    },
    create: () => render(<ChatScreen {...options} onShutdownReady={owner => { shutdown = owner; }} />, {
      incrementalRendering: true,
      maxFps: 15,
      kittyKeyboard: {mode: 'auto', flags: ['disambiguateEscapeCodes']},
      exitOnCtrlC: false,
      // Ink 8 render metrics: direct observability of per-frame render cost
      // under --debug, alongside the estimator-based live-region clamp.
      ...(options.debug ? {onRender: ({renderTime}: {renderTime: number}) => {
        lastRenderMetricsMs = {at: Date.now(), renderTime};
      }} : {}),
    }),
    shutdown: () => shutdown?.(),
    restore: () => {
      removeResizeGuard();
      resetTerminalColors();
    },
  });
}
