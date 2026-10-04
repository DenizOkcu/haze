import React, {useEffect, useReducer, useRef, useState} from 'react';
import {Box, render, Static, Text, useApp, useWindowSize} from 'ink';
import Spinner from 'ink-spinner';
import {type ModelMessage} from 'ai';
import type {PromptSession} from '../../llm/systemPrompt.js';
import {readContextFiles, type ContextFile} from '../../config/contextFiles.js';
import {addInputHistoryItem, readInputHistory} from '../../config/inputHistory.js';
import {loadTasks as loadTasksFromStore, clearTasks as clearTasksFromStore} from '../../core/tasks/taskStorage.js';
import type {Task} from '../../core/tasks/taskStorage.js';
import {readSettings, updateSettings, type HazeSettings} from '../../config/settings.js';
import {activeModel, activeProvider} from '../../config/providers.js';
import {isSkillEnabled} from '../../config/skillSettings.js';
import {Header} from '../../ui/components/Header.js';
import {TextInput} from '../../ui/components/TextInput.js';
import {setActiveTheme, resolveTheme, theme, DEFAULT_THEME_NAME} from '../../ui/theme.js';
import {applyTerminalColors, resetTerminalColors} from '../../ui/terminalColors.js';
import {handleSlashCommand, type CommandContext} from './commands.js';
import {runAgentGoal} from './streaming/goalSupervisor.js';
import type {GoalCheckpoint} from './streaming/goalCheckpoint.js';
import {checkpointFromGoalFrontier} from './streaming/goalCheckpoint.js';
import {type Message} from './streaming.js';
import type {TokenUsage} from './streaming/turnRuntime.js';
import {imageAttachmentLine} from './formatters.js';
import {imageCapabilityError, IMAGE_ONLY_PROMPT_TEXT, resolveImageAttachments} from '../../core/attachments/imageAttachments.js';
import {resolveReadBlessings} from '../../core/attachments/readBlessings.js';
import {type LlmLog, endLog as endLlmLog} from '../../core/log/llmLog.js';
import {loadSkillRegistry} from '../../skills/SkillRegistry.js';
import type {LoadedSkill} from '../../skills/types.js';
import {formatSession, listSessions, type HazeSession, type SessionSummary} from '../../core/session/sessionStore.js';
import type {WorkState} from '../../core/agent/workState.js';
import {MAX_VISIBLE_TASKS, TaskBar} from '../chat/TaskBar.js';
import {DynamicFrame} from '../chat/DynamicFrame.js';
import {createChatShutdown, runTerminalSession} from '../chat/shutdown.js';
import {createQuarantinableCallbacks} from './streaming/attemptLifecycle.js';
import {AssistantMarkdownChunkView, MessageView} from '../chat/messages.js';
import {partitionDisplayMessages, type TranscriptStaticItem} from '../chat/transcriptPartition.js';
import {useLiveMessages} from '../chat/liveMessages.js';
import {createSessionRecorder, type SessionRecorder} from '../chat/sessionRecorder.js';
import {createSessionLifecycle} from '../chat/sessionLifecycle.js';
import {createWizardDispatch, initialWizardUiState, wizardUiReducer} from '../chat/wizardDispatch.js';
import {buildContextReport} from '../chat/contextReport.js';
import {TIPS, randomTipIndex, tipsEnabled} from '../chat/tips.js';
import {fileMentionSuggestions} from '../chat/fileMentionSuggestions.js';
import {compactHomePath, statusBarMetrics} from '../chat/chatMetrics.js';
import {formatTokenCount} from '../../utils/format.js';
import {accumulateTokenUsage, EMPTY_TOKEN_USAGE, shouldClearCompletedTasks} from '../chat/turnState.js';
import {MASKED_MODES, PICKER_MODES, SUBMIT_EMPTY_MODES, placeholderForMode, type Mode} from './chatModes.js';
import {DEFAULT_REASONING_LEVEL, isReasoningLevel} from '../../core/agent/reasoningPolicy.js';
import {inputSuggestionsForState} from '../chat/inputSuggestions.js';
import {currentBranchName, runStartupSequence} from '../chat/startupSequence.js';
import {useFollowUpQueue} from '../chat/followUpQueue.js';
import {useBusyIndicator} from '../chat/busyIndicator.js';
import {modelThinkingLabel} from '../../utils/modelName.js';
import {commandParts} from './wizardFlow.js';
import {backgroundProcessCount, subscribeBackgroundProcesses, teardownBackgroundProcesses} from '../../core/process/backgroundRegistry.js';
import {MAX_SESSION_PICKER_RESULTS} from './sessionPicker.js';

interface ChatOptions {
  debug?: boolean;
  version?: string;
  /** Safe build provenance (commit, build time) recorded into session headers. */
  build?: {commit?: string; builtAt?: string};
  continueSession?: boolean;
  resumeSessionId?: string;
  noSession?: boolean;
}

type ChatStaticItem = {kind: 'header'; key: string; subtitle: React.ReactNode} | TranscriptStaticItem;

function thinkingLabelForSettings(settings: HazeSettings) {
  return modelThinkingLabel(activeModel(settings)?.model);
}

/**
 * Busy indicator isolated in its own component. The Spinner animates on its own
 * internal state (~10 fps) which triggers re-renders inside this subtree; keeping
 * the spinner out of ChatScreen's render scope means those ticks don't propagate
 * to the transcript tree above (where React.memo on MessageView already prevents
 * deep re-renders, but avoiding the reconciliation walk entirely is still cheaper).
 */
function BusyBar({label, elapsed, tip}: {label: string; elapsed: string; tip?: string}) {
  return <Box flexDirection="column" flexShrink={0}>
    <Box>
      <Text><Text color={theme.command} bold><Spinner type="dots" /> {label}{elapsed ? <Text color={theme.muted}> · {elapsed}</Text> : null}</Text><Text color={theme.muted}> · type to queue follow-up · esc to interrupt</Text></Text>
    </Box>
    {tip && (
      <Box>
        <Text color={theme.muted}><Text bold>Tip:</Text> {tip}</Text>
      </Box>
    )}
  </Box>;
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
  const [settings, setSettings] = useState<HazeSettings>({});
  const [settingsError, setSettingsError] = useState<string | undefined>();
  const conversationRef = useRef<ModelMessage[]>([]);
  const lastAssistantTextRef = useRef('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<HazeSession | undefined>(undefined);
  const sessionRecorderRef = useRef<SessionRecorder | undefined>(undefined);
  if (!sessionRecorderRef.current) sessionRecorderRef.current = createSessionRecorder(() => sessionRef.current);

  /** Finalize a formerly-live message into the append-only transcript and session record. */
  function finalizeMessage(message: Message) {
    if (message.hidden || sealedRef.current) return;
    const ordered = withDisplayOrder(message);
    setMessages(m => [...m, ordered]);
    sessionRecorderRef.current?.recordUiMessage(ordered);
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
  const workStateRef = useRef<WorkState | undefined>(undefined);
  const llmLogRef = useRef<LlmLog | undefined>(undefined);
  const persistenceWarningShownRef = useRef(false);
  const skillErrorSignatureRef = useRef('');
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
  const [pausedResume, setPausedResume] = useState<{kind: 'model-stream-idle' | 'incomplete-goal'; request: string; retryAttempt: number; checkpoint?: GoalCheckpoint; pauseReason?: 'no-progress' | 'goal-deadline' | 'context-exhausted'} | undefined>(undefined);
  const [skills, setSkills] = useState<LoadedSkill[]>([]);
  const [branchName, setBranchName] = useState<string | undefined>();
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
  const {modelProviderFilter, discoveredModels, suggestedModels, selectedProviderName, providerDraft, selectedSkillName, selectedLspName, selectedMcpName} = wizardState;

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
        contextFileSignaturesRef.current = new Map(files.flatMap(file => file.signature ? [[file.path, file.signature] as const] : []));
      },
      initializeSession: () => sessionLifecycle.initializeSession(),
      refreshSkills,
      addSystemMessage: text => setMessages(m => [...m, {role: 'system', text}]),
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
  const {clearConversation, compactConversation, compactConversationWithModel} = sessionLifecycle;

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
  });

  async function submit(value: string) {
    if (stoppingRef.current) return;
    if (mode === 'chat' && /^\/(?:exit|quit)\s*$/i.test(value)) return shutdown();
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
      if (mode === 'chat') followUps.queue(value);
      return;
    }
    // A new goal or session reset supersedes the paused-goal resume affordance;
    // recovery/configuration commands (compact, model, provider, settings,
    // resume…) intentionally keep it — the pause notice tells the user to run
    // exactly those and then press R (SU-04).
    const isRecoveryCommand = mode !== 'chat' || /^(?:\/compact|\/model|\/provider|\/settings|\/themes|\/resume|\/sessions)\b/.test(value.trim());
    if (pausedResume && !isRecoveryCommand) setPausedResume(undefined);

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
      setModelProviderFilter: (filter: string | undefined) => updateWizard({type: 'set', key: 'modelProviderFilter', value: filter}),
      addSystemMessage: text => setMessages(m => [...m, {role: 'system', text}]),
      clearConversation,
      newSession: async () => {
        conversationRef.current = [];
        lastAssistantTextRef.current = '';
        clearLiveMessages();
        setMessages([{role: 'system', text: 'Started fresh. The fog parts.'}]);
        await sessionLifecycle.startNewSession('New session started.');
      },
      resumeSession: noSession ? undefined : async id => {
        if (id) await sessionLifecycle.resumeSessionById(id);
        else await openSessionPicker();
      },
      sessionInfo: () => sessionRef.current ? formatSession(sessionRef.current) : 'Session persistence is off.',
      compactConversation,
      compactConversationLlm: compactConversationWithModel,
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
    if (result === 'exit') return shutdown();
    if (result === 'handled') {
      if (value === '/clear') {
        loadTasksFromStore().then(t => { setVisibleTasks(t); setTaskBarPadding(0); }).catch(() => undefined);
      }
      return;
    }

    const prepared = await prepareUserInput(value);
    if (!prepared) return;
    await doAgentTurn(prepared.value, prepared.displayValue, prepared.options);
  }

  // F03: resolve @image mentions in a prompt the user typed into attachments and
  // gate them on the active provider's explicit capability before any model call.
  // Applied only to genuine user input (direct chat and queued follow-ups), never
  // to synthetic control prompts (/init, /fleet, skill invocations). Resolution
  // errors and capability rejections surface an actionable system message and
  // return undefined instead of starting a turn.
  async function prepareUserInput(value: string): Promise<{value: string; displayValue?: string; options: import('./streaming.js').TurnExecutionOptions} | undefined> {
    let resolved;
    try {
      resolved = await resolveImageAttachments(value);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessages(m => [...m, {role: 'system', text}]);
      return undefined;
    }
    const blessed = await resolveReadBlessings(resolved.text);
    if (resolved.attachments.length === 0 && blessed.blessedPaths.length === 0) return {value, options: {}};
    const gateError = imageCapabilityError(activeProvider(settings));
    if (resolved.attachments.length > 0 && gateError) {
      setMessages(m => [...m, {role: 'system', text: gateError}]);
      return undefined;
    }
    const displayValue = [resolved.text, ...resolved.attachments.map(imageAttachmentLine)].filter(Boolean).join('\n');
    return {
      value: resolved.text || IMAGE_ONLY_PROMPT_TEXT,
      displayValue,
      options: {attachments: resolved.attachments, blessedPaths: blessed.blessedPaths},
    };
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
   * Resume a paused turn against the preserved conversation (no re-added user
   * message). An idle-stall resume continues the same logical turn's bounded
   * retry pool; an incomplete-goal resume starts a fresh logical turn (its
   * budget was exhausted) nudged to pick up the remaining concrete work.
   */
  /**
   * Explicitly resume a genuinely paused goal (automatic continuation already
   * ran): an idle-stall resume continues the bounded retry pool; an
   * incomplete-goal resume restarts the supervisor from the stored checkpoint.
   * Both ride the preserved conversation — no completed mutations are replayed.
   */
  async function resumePausedTask() {
    const resume = pausedResume;
    if (!resume || busy) return;
    setPausedResume(undefined);
    setMessages(m => [...m, {role: 'system', text: 'Resuming the unfinished goal; completed work is preserved in the conversation.'}]);
    const resumeFrom = resume.kind === 'incomplete-goal' && resume.checkpoint
      ? {kind: 'incomplete-goal' as const, checkpoint: resume.checkpoint}
      : {kind: 'model-stream-idle' as const, retryAttempt: resume.retryAttempt};
    await runSingleAgentTurn(resume.request, undefined, {}, resumeFrom);
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

  async function runSingleAgentTurn(value: string, displayValue?: string, turnOptions: import('./streaming.js').TurnExecutionOptions = {}, resumeExisting?: {kind: 'model-stream-idle'; retryAttempt: number} | {kind: 'incomplete-goal'; checkpoint: GoalCheckpoint}) {
    if (stoppingRef.current) return;
    const sessionRecorder = sessionRecorderRef.current!;

    // The logical-goal supervisor owns this submission: recoverable-incomplete
    // physical turns (including step/tool budget boundaries) continue
    // automatically; per-turn limits stay safety boundaries. An explicit
    // resumeFrom restarts a genuinely paused goal from its checkpoint/pool.
    const goalOptions = {
      request: value,
      displayValue,
      contextFiles,
      session: currentPromptSession(),
      escalationModel: settings.escalationModel,
      callbacks: {
      addMessage: msg => {
        const ordered = withDisplayOrder(msg);
        if (ordered.streaming) {
          addStreaming(ordered);
          return;
        }
        finalizeMessage(ordered);
      },
      updateMessage: (id, update) => {
        if (patchLiveMessage(id, update)) return;
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
      setAbortController: controller => {
        abortControllerRef.current = controller;
        if (stoppingRef.current) controller?.abort('Chat is exiting.');
      },
      setWorkState: state => {
        workStateRef.current = state;
        sessionRecorder.recordWorkState(state);
      },
      compactConversation,
      recordCompaction: entry => sessionRecorder.recordCompactEntry(entry),
      recordTokenUsage: usage => {
        setTokenUsage(current => accumulateTokenUsage(current, usage));
      },
      onEvent: event => {
        sessionRecorder.recordEvent(event);
      },
      onTasksChanged: () => { loadTasksFromStore().then(t => {
        if (stoppingRef.current) return;
        setVisibleTasks(t); setTaskBarPadding(0);
      }).catch(() => undefined); },
      contextFileSignatures: contextFileSignaturesRef.current,
      log: llmLogRef.current,
    },
    ...(resumeExisting ? {resumeFrom: resumeExisting} : {}),
    // Durable goal ledger (P1): every supervisor boundary appends to the
    // session JSONL so a crash or restart leaves a resumable frontier.
    goalLedger: {append: entry => { if (!sealedRef.current) sessionRecorder.recordGoalEntry(entry); }},
    ...(turnOptions.attachments || turnOptions.blessedPaths || turnOptions.ephemeralControl || turnOptions.subagentOverrides ? {turnOptions} : {})} satisfies Parameters<typeof runAgentGoal>[0];
    const guarded = createQuarantinableCallbacks(goalOptions.callbacks);
    quarantineRef.current = guarded.quarantine;
    const goalPromise = runAgentGoal({...goalOptions, callbacks: guarded.callbacks});
    activeGoalRef.current = goalPromise;
    const goalResult = await goalPromise;
    activeGoalRef.current = undefined;
    if (stoppingRef.current) return goalResult;
    await sessionRecorder.flush().catch(showPersistenceWarning);
    await llmLogRef.current?.writer?.flush().catch(showPersistenceWarning);
    // Turn boundary: an aborted or forcibly-settled attempt is quarantined
    // before it can emit the finalizing update, so settle anything still in
    // the live tail now; the streamed text is preserved verbatim in <Static>.
    drainLiveMessages();
    // Only a genuinely paused goal (supervisor already attempted automatic
    // continuation) exposes the one-key resume affordance; it stays until the
    // user submits something else.
    if (goalResult.resume?.kind === 'model-stream-idle') setPausedResume({kind: 'model-stream-idle', request: goalResult.resume.request, retryAttempt: goalResult.resume.retryAttempt});
    else if (goalResult.resume?.kind === 'incomplete-goal') setPausedResume({kind: 'incomplete-goal', request: goalResult.resume.checkpoint.request, retryAttempt: 0, checkpoint: goalResult.resume.checkpoint, pauseReason: goalResult.stopReason === 'context-exhausted' || goalResult.stopReason === 'goal-deadline' || goalResult.stopReason === 'no-progress' ? goalResult.stopReason : undefined});
    else setPausedResume(undefined);
    return goalResult;
  }

  const visible = messages.filter(message => !message.hidden);
  const activeLiveMessages = liveMessages.filter(message => !message.hidden);
  const {staticItems: staticTranscriptItems, streamingItems} = partitionDisplayMessages([...visible, ...activeLiveMessages]);
  const activeSelection = activeModel(settings);
  const placeholder = placeholderForMode(mode, busy);
  const activeModelName = activeSelection ? `${activeSelection.provider.name}:${activeSelection.model}` : 'unconfigured';
  const reasoningSuffix = isReasoningLevel(settings.reasoning) || settings.reasoning === undefined
    ? ` (${isReasoningLevel(settings.reasoning) ? settings.reasoning : DEFAULT_REASONING_LEVEL})`
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
  const enabledSkillCount = new Set(skills.filter(skill => isSkillEnabled(settings, skill.name, skill.source)).map(skill => skill.name)).size;
  const metrics = statusBarMetrics({messages: [...messages, ...liveMessages], tokenUsage, enabledSkillCount, backgroundProcessCount: backgroundCount});
  const inputSuggestions = inputSuggestionsForState({mode, settings, skills, sessions, selectedProviderName, modelProviderFilter, providerDraftName: providerDraft.name, discoveredModels, suggestedModels, selectedSkillName, selectedLspName, selectedMcpName});
  const staticItems: ChatStaticItem[] = [
    {kind: 'header', key: 'header', subtitle: headerSubtitle},
    ...staticTranscriptItems,
  ];
  const horizontalPadding = width >= 12 ? 1 : 0;
  const contentWidth = Math.max(1, width - horizontalPadding * 2);

  return <Box flexDirection="column" paddingX={horizontalPadding}>
    <Static items={staticItems}>
      {item => item.kind === 'header'
        ? <Header key={item.key} subtitle={item.subtitle} version={version} />
        : item.kind === 'assistant-markdown'
          ? <AssistantMarkdownChunkView key={item.key} message={item.message} content={item.content} width={contentWidth} first={item.first} final={item.final} />
          : <MessageView key={item.key} message={item.message} width={contentWidth} />}
    </Static>
    <DynamicFrame rows={terminalRows} columns={contentWidth} sections={{
      live: streamingItems.length > 0 ? rows => {
        // Allocate the sum, not a positive minimum for every pending item.
        const displayed = streamingItems.slice(0, Math.floor(rows / 2));
        const itemRows = displayed.length > 0 ? Math.floor(rows / displayed.length) : 0;
        return displayed.map(item => <Box key={item.key} height={itemRows} flexShrink={0} overflow="hidden">
          <MessageView message={item.message} width={contentWidth} showHeader={item.showHeader}
            maxVisibleLines={itemRows - 1} />
        </Box>);
      } : undefined,
      debug: debug ? <>
        {debugLogs.map((line, index) => <Text key={index} color={theme.muted} wrap="truncate-end">• {line}</Text>)}
        {metrics.hasTokenBreakdown && <Text color={theme.muted} wrap="truncate-end">Tokens: in={formatTokenCount(metrics.effectiveInput)} out={formatTokenCount(metrics.effectiveOutput)} logical={formatTokenCount(tokenUsage.logicalInputEstimate)}</Text>}
      </> : undefined,
      queue: followUps.queued.length > 0 ? <>
        <Text color={theme.muted} wrap="truncate-end">Queued follow-ups: {followUps.queued.length}</Text>
        {followUps.queued.map((item, index) => <Text key={`${index}-${item}`} color={theme.muted} wrap="truncate-end">{index + 1}. {item}</Text>)}
      </> : undefined,
      tasks: visibleTasks.length > 0 ? <TaskBar tasks={visibleTasks} width={contentWidth} expanded={tasksExpanded} padding={taskBarPadding} maxRows={Math.max(1, terminalRows - 8)} /> : undefined,
      activity: busy ? <BusyBar label={busyLabel} elapsed={busyElapsed} tip={showingTip ? TIPS[tipIndex] : undefined} />
        : pausedResume ? <Text color={theme.command} wrap="truncate-end">Press R to resume · unfinished goal paused{pausedResume.pauseReason ? ` (${pausedResume.pauseReason})` : ''}</Text> : undefined,
      status: <>
        <Text color={theme.muted} wrap="truncate-end">{workspaceLabel}</Text>
        <Text color={theme.muted} wrap="truncate-end">{metrics.statusDetailLabel} · {activeModelName}{reasoningSuffix}</Text>
      </>,
    }} input={({width: inputWidth, inputRows, suggestionRows, onRowsChange}) => <TextInput
      placeholder={placeholder}
      disabled={busy && mode !== 'chat'}
      mask={MASKED_MODES.has(mode)}
      historyItems={inputHistory}
      recordHistory={mode === 'chat'}
      suggestions={inputSuggestions}
      suggestionMode={PICKER_MODES.has(mode) ? 'always' : 'slash'}
      submitOnEmpty={SUBMIT_EMPTY_MODES.has(mode)}
      width={inputWidth}
      inputRows={inputRows}
      suggestionRows={suggestionRows}
      onRowsChange={onRowsChange}
      getMentionSuggestions={fileMentionSuggestions}
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
      onResumeKey={pausedResume != null && !busy ? resumePausedTask : undefined}
      onInterrupt={() => { void shutdown(); }}
      onEscape={() => {
        if (busy) cancelThinking();
        else closeInputList();
      }}
      onSubmit={submit}
    />} />
  </Box>;
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
    }),
    shutdown: () => shutdown?.(),
    restore: resetTerminalColors,
  });
}
