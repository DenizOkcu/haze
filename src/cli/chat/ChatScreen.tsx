import React, {useEffect, useReducer, useRef, useState} from 'react';
import {useApp, useWindowSize} from 'ink';
import {type ModelMessage} from 'ai';
import type {ContextFile} from '../../config/contextFiles.js';
import {addInputHistoryItem, readInputHistory} from '../../config/inputHistory.js';
import {loadTasks as loadTasksFromStore, clearTasks as clearTasksFromStore} from '../../core/tasks/taskStorage.js';
import type {Task} from '../../core/tasks/taskStorage.js';
import type {HazeSettings} from '../../config/settings.js';
import {activeModel} from '../../config/providers.js';
import {isSkillEnabled} from '../../config/skillSettings.js';
import {checkpointFromGoalFrontier} from '../commands/streaming/goalCheckpoint.js';
import {finalizeMessage as finalizeMessageImpl} from './messageFinalize.js';
import {submit as submitImpl} from './submitPipeline.js';
import {runAgentTurnWithFollowUps, resumePausedGoal} from './agentTurnRunner.js';
import type {ChatScreenDeps, PausedResume} from './screenDeps.js';
import type {HazeSession, SessionSummary} from '../../core/session/sessionStore.js';
import type {TokenUsage} from '../commands/streaming/turnRuntime.js';
import {type LlmLog, endLog as endLlmLog} from '../../core/log/llmLog.js';
import type {LoadedSkill} from '../../skills/types.js';
import type {WorkState} from '../../core/agent/workState.js';
import {taskBarCollapsePadding} from './TaskBar.js';
import {createChatShutdown} from './shutdown.js';
import {createResizeSettler} from './resizeGuard.js';
import {useChatViewModel} from './chatViewModel.js';
import {ChatHeaderSubtitle} from './ChatHeader.js';
import {readRenderMetrics} from './renderMetrics.js';
import {ChatScreenView, type ChatStaticItem} from './ChatScreenView.js';
import {useLiveMessages} from './liveMessages.js';
import {createSessionRecorder, type SessionRecorder} from './sessionRecorder.js';
import {createSessionLifecycle} from './sessionLifecycle.js';
import {createWizardDispatch, initialWizardUiState, wizardUiReducer} from './wizardDispatch.js';
import {randomTipIndex, tipsEnabled} from './tips.js';
import type {FleetStatus} from './chatMetrics.js';
import {EMPTY_TOKEN_USAGE} from './turnState.js';
import type {Mode} from '../commands/chatModes.js';
import {contextFileSignatureMap, prepareUserInput as prepareUserInputPolicy} from './userInput.js';
import {currentBranchName, runStartupSequence} from './startupSequence.js';
import {useFollowUpQueue} from './followUpQueue.js';
import {useBusyIndicator} from './busyIndicator.js';
import {useTerminalControl} from './terminalControl.js';
import {modelThinkingLabel} from '../../utils/modelName.js';
import {commandParts} from '../commands/wizardFlow.js';
import {backgroundProcessCount, subscribeBackgroundProcesses, teardownBackgroundProcesses} from '../../core/process/backgroundRegistry.js';
import {loadSkillsWithNotices, initialSkillNoticeState, type SkillNoticeState} from './skillNotices.js';
import {createPickerOpeners} from './pickerOpeners.js';
import {useSettingsSelection} from './settingsSelection.js';
import {useLiveTheme} from './liveTheme.js';
import {usePromptSession} from './promptSessionState.js';
import {type Message, type TurnExecutionOptions} from '../commands/streaming.js';

export interface ChatOptions {
  debug?: boolean;
  version?: string;
  /** Safe build provenance (commit, build time) recorded into session headers. */
  build?: {commit?: string; builtAt?: string};
  continueSession?: boolean;
  resumeSessionId?: string;
  noSession?: boolean;
}


function thinkingLabelForSettings(settings: HazeSettings) {
  return modelThinkingLabel(activeModel(settings)?.model);
}

export function ChatScreen({debug = false, version, build, continueSession = false, resumeSessionId, noSession = false, onShutdownReady}: ChatOptions & {onShutdownReady?: (shutdown: () => Promise<void>) => void}) {
  const {exit} = useApp();
  const {columns: width, rows: terminalRows} = useWindowSize();
  // The viewport clears on every width change, but the Static replay that
  // re-parses the whole transcript waits for the resize to settle (FE-04).
  // `tick` forces a replay even when the width returns to its settled value,
  // because the clear already removed the history from the viewport.
  const [replay, setReplay] = useState({tick: 0, width});
  const previousWidth = useRef(width);
  useEffect(() => {
    if (width === previousWidth.current) return;
    previousWidth.current = width;
    const settler = createResizeSettler(settled => setReplay(current => ({tick: current.tick + 1, width: settled})));
    settler.next(width);
    return () => settler.cancel();
  }, [width]);
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
  const [settingsError, setSettingsError] = useState<string | undefined>();
  const conversationRef = useRef<ModelMessage[]>([]);
  const lastAssistantTextRef = useRef('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<HazeSession | undefined>(undefined);
  const sessionRecorderRef = useRef<SessionRecorder | undefined>(undefined);
  if (!sessionRecorderRef.current) sessionRecorderRef.current = createSessionRecorder(() => sessionRef.current);
  // Settings state and the session-pinned model selection live in chat/settingsSelection.ts.
  const {settings, settingsRef, defaultSelectionRef, setSettings, setSettingsRaw, currentModelSelection} = useSettingsSelection({conversationRef, sessionRecorderRef, setMessages});

  /** Finalize a formerly-live message into the append-only transcript and session record. */
  function finalizeMessage(message: Message) {
    finalizeMessageImpl(screenDeps(), message);
  }

  // Synchronous live-tail store (see chat/liveMessages.ts): stream callbacks
  // that land inside one React batch window must route against fresh state.
  const {liveMessages, addStreaming, patch: patchLiveMessage, drain: drainLiveMessages, clear: clearLiveMessages} = useLiveMessages(finalizeMessage);
  const sessionStartRef = useRef<Date>(new Date());
  // The stable PromptSession and its per-model reasoning overrides live in chat/promptSessionState.ts.
  const {currentPromptSession, setSessionReasoningOverride, reasoningOverrideCounter} = usePromptSession(sessionStartRef);
  const workStateRef = useRef<WorkState | undefined>(undefined);
  const llmLogRef = useRef<LlmLog | undefined>(undefined);
  const persistenceWarningShownRef = useRef(false);
  const skillNoticesRef = useRef<SkillNoticeState>(initialSkillNoticeState());
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

  // Live theme switching (/themes) lives in chat/liveTheme.ts.
  const settingsThemeLoadedRef = useRef(false);
  useLiveTheme(settings, stoppingRef, settingsThemeLoadedRef);


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
    const next = await loadSkillsWithNotices(skillNoticesRef.current);
    skillNoticesRef.current = next.state;
    setSkills(next.skills);
    for (const text of next.messages) setMessages(messages => [...messages, {role: 'system', text}]);
    return next.skills;
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
  const {openSessionPicker, openPluginPicker} = createPickerOpeners({
    flush: () => sessionRecorderRef.current?.flush() ?? Promise.resolve(),
    onFlushError: showPersistenceWarning,
    setSessions,
    updateWizard,
    setMode,
    setMessages,
  });

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
  async function prepareUserInput(value: string): Promise<{value: string; displayValue?: string; options: TurnExecutionOptions} | undefined> {
    const prepared = await prepareUserInputPolicy(value, settings);
    if (prepared?.error) {
      setMessages(m => [...m, {role: 'system', text: prepared.error!}]);
      return undefined;
    }
    return prepared;
  }

  // Turn submission (follow-up drain) and the one-key paused-goal resume live
  // in chat/agentTurnRunner.ts.
  function doAgentTurn(value: string, displayValue?: string, turnOptions: TurnExecutionOptions = {}) {
    return runAgentTurnWithFollowUps(screenDeps(), value, displayValue, turnOptions);
  }

  function resumePausedTask() {
    return resumePausedGoal(screenDeps());
  }

  /** Assemble the explicit deps bundle the extracted ChatScreen bodies receive. */
  function screenDeps(): ChatScreenDeps {
    return {
      stoppingRef, sealedRef, quarantineRef, activeGoalRef, conversationRef, settingsRef,
      sessionRef, sessionRecorderRef, sessionStartRef, workStateRef, lastAssistantTextRef,
      abortControllerRef, llmLogRef, contextFileSignaturesRef,
      settings, settingsError, contextFiles, mode, busy, pausedResume, visibleTasks,
      setMessages, setSettings, setSettingsError, setMode, setContextFiles,
      setBusy: setBusyWithHeartbeat, setBusyLabel, setTokenUsage, setFleet,
      setVisibleTasks, setTaskBarPadding, setTasksExpanded, setPausedResume, setDebugLogs, updateWizard,
      currentModelSelection, currentPromptSession, withDisplayOrder, finalizeMessage,
      addStreaming, patchLiveMessage, drainLiveMessages, clearLiveMessages,
      debugLog, showPersistenceWarning, skillInvocation, prepareUserInput, doAgentTurn,
      openSessionPicker, openPluginPicker, refreshSkills, setSessionReasoningOverride,
      shutdown, followUps, wizard, sessionLifecycle, terminalControl, noSession,
    };
  }

  // Derived render values (memoised on the identity of their inputs, FE-03)
  // live in chat/chatViewModel.ts; only the header item is composed here.
  const view = useChatViewModel({
    messages, liveMessages, busy, fleet, settings, mode, tokenUsage, backgroundCount, skills, branchName, sessions,
    wizard: wizardState,
    selectedModel: currentModelSelection(),
    sessionReasoning: currentPromptSession().reasoningByModel,
    reasoningOverrideCounter, width, replayWidth: replay.width,
  });
  const staticItems: ChatStaticItem[] = [{kind: 'header', key: 'header', subtitle: <ChatHeaderSubtitle />}, ...view.staticTranscriptItems];


  // The pure screen render (static transcript + dynamic frame) lives in chat/ChatScreenView.tsx.
  return <ChatScreenView
    version={version} debug={debug} terminalRows={terminalRows}
    horizontalPadding={view.horizontalPadding} contentWidth={view.contentWidth}
    replay={{key: `${replay.tick}:${replay.width}`, contentWidth: view.replayContentWidth}}
    staticItems={staticItems} streamingItems={view.streamingItems}
    debugLogs={debugLogs} metrics={view.metrics} renderMetricsReader={readRenderMetrics}
    tokenUsage={tokenUsage} followUps={followUps} visibleTasks={visibleTasks}
    tasksExpanded={tasksExpanded} taskBarPadding={taskBarPadding}
    busy={busy} busyLabel={busyLabel} busyElapsed={busyElapsed} busyDetail={view.busyDetail}
    showingTip={showingTip} tipIndex={tipIndex} graphBuilding={graphBuilding}
    pausedResume={pausedResume} workspaceLabel={view.workspaceLabel}
    activeModelName={view.activeModelName} reasoningSuffix={view.reasoningSuffix}
    placeholder={view.placeholder} mode={mode} inputHistory={inputHistory}
    inputSuggestions={view.inputSuggestions}
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
        setTaskBarPadding(taskBarCollapsePadding(visibleTasks.length));
        setTasksExpanded(false);
      }
    }}
  />;
}
