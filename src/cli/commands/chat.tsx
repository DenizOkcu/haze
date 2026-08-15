import React, {useEffect, useRef, useState} from 'react';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {Box, render, Static, Text, useApp, useWindowSize} from 'ink';
import Spinner from 'ink-spinner';
import {type ModelMessage} from 'ai';
import {readContextFiles, type ContextFile} from '../../config/contextFiles.js';
import {checkForUpdate} from '../../config/updateCheck.js';
import {addInputHistoryItem, readInputHistory} from '../../config/inputHistory.js';
import {loadTasks as loadTasksFromStore, clearTasks as clearTasksFromStore} from '../../core/tasks/taskStorage.js';
import type {Task} from '../../core/tasks/taskStorage.js';
import {readSettings, updateSettings, type HazeMcpServer, type HazeProviderSettings, type HazeSettings} from '../../config/settings.js';
import {activeModel, activeProvider} from '../../config/providers.js';
import {type HazeLspServer} from '../../config/lspSettings.js';
import {isSkillEnabled} from '../../config/skillSettings.js';
import {Header} from '../../ui/components/Header.js';
import {TextInput} from '../../ui/components/TextInput.js';
import {theme} from '../../ui/theme.js';
import {handleSlashCommand, type CommandContext} from './commands.js';
import {runAgentTurn, type Message, type TokenUsage} from './streaming.js';
import {formatElapsedTimeWhole, imageAttachmentLine} from './formatters.js';
import {imageCapabilityError, IMAGE_ONLY_PROMPT_TEXT, resolveImageAttachments} from '../../core/attachments/imageAttachments.js';
import {resolveReadBlessings} from '../../core/attachments/readBlessings.js';
import {type LlmLog, endLog as endLlmLog} from '../../core/log/llmLog.js';
import {loadSkillRegistry} from '../../skills/SkillRegistry.js';
import type {LoadedSkill, SkillSource} from '../../skills/types.js';
import {formatSession, listSessions, type HazeSession, type SessionSummary} from '../../core/session/sessionStore.js';
import type {WorkState} from '../../core/agent/workState.js';
import {MAX_VISIBLE_TASKS, TaskBar} from '../chat/TaskBar.js';
import {AssistantMarkdownChunkView, MessageView, partitionDisplayMessages, type TranscriptStaticItem} from '../chat/messages.js';
import {createSessionRecorder, type SessionRecorder} from '../chat/sessionRecorder.js';
import {createSessionLifecycle} from '../chat/sessionLifecycle.js';
import {createWizardDispatch} from '../chat/wizardDispatch.js';
import {buildContextReport} from '../chat/contextReport.js';
import {startupContextInfo, startupProviderInfo} from '../chat/startupInfo.js';
import {TIPS, randomTipIndex, tipsEnabled} from '../chat/tips.js';
import {fileMentionSuggestions} from '../chat/fileMentionSuggestions.js';
import {compactHomePath, formatTokenCount, statusBarMetrics} from '../chat/chatMetrics.js';
import {formatCostUsd} from '../../core/agent/costAccounting.js';
import {accumulateTokenUsage, EMPTY_TOKEN_USAGE, shouldClearCompletedTasks} from '../chat/turnState.js';
import {MASKED_MODES, PICKER_MODES, SUBMIT_EMPTY_MODES, placeholderForMode, type Mode} from './chatModes.js';
import {inputSuggestionsForState} from '../chat/inputSuggestions.js';
import {modelThinkingLabel} from '../../utils/modelName.js';
import {transitionMcpField, transitionProviderField} from './wizardTransition.js';
import {commandParts} from './wizardInput.js';
import {backgroundProcessCount, subscribeBackgroundProcesses, teardownBackgroundProcesses} from '../../core/process/backgroundRegistry.js';
import {MAX_SESSION_PICKER_RESULTS} from './sessionPicker.js';

interface ChatOptions {
  debug?: boolean;
  version?: string;
  continueSession?: boolean;
  resumeSessionId?: string;
  noSession?: boolean;
}

type ChatStaticItem = {kind: 'header'; key: string; subtitle: React.ReactNode} | TranscriptStaticItem;

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

function ChatScreen({debug = false, version, continueSession = false, resumeSessionId, noSession = false}: ChatOptions) {
  const {exit} = useApp();
  const {columns: width} = useWindowSize();
  const nextDisplayOrderRef = useRef(1);
  const withDisplayOrder = (message: Message): Message => {
    if (message.displayOrder != null) return message;
    return {...message, displayOrder: nextDisplayOrderRef.current++};
  };
  const withDisplayOrders = (next: Message[]) => next.map(withDisplayOrder);
  const [messages, setMessagesRaw] = useState<Message[]>([]);
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
  const projectSkillSignatureRef = useRef('');
  const contextFileSignaturesRef = useRef<Map<string, string>>(new Map());
  const followUpQueueRef = useRef<string[]>([]);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  const [mode, setMode] = useState<Mode>('chat');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [backgroundCount, setBackgroundCount] = useState(backgroundProcessCount);
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
  const [suggestedModels, setSuggestedModels] = useState<string[]>([]);
  const [selectedProviderName, setSelectedProviderName] = useState<string | undefined>();
  const [providerDraft, setProviderDraft] = useState<Partial<HazeProviderSettings>>({});
  const [skillDraft, setSkillDraft] = useState<{name?: string; scope?: SkillSource}>({});
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
  useEffect(() => subscribeBackgroundProcesses(() => setBackgroundCount(backgroundProcessCount())), []);

  useEffect(() => {
    if (!busy) return;
    const heartbeat = setInterval(() => setBusyTick(tick => tick + 1), 1000);
    return () => clearInterval(heartbeat);
  }, [busy]);

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

  useEffect(() => {
    void (async () => {
      const [settingsResult, branch, files] = await Promise.all([
        readSettings().then(value => ({value, error: undefined as string | undefined})).catch(error => ({value: {} as HazeSettings, error: error instanceof Error ? error.message : String(error)})),
        currentBranchName().catch(() => undefined),
        readContextFiles().catch(() => [] as ContextFile[]),
      ]);
      const next = settingsResult.value;
      setSettings(next);
      setSettingsError(settingsResult.error);
      setBranchName(branch);
      setContextFiles(files);
      contextFileSignaturesRef.current = new Map(files.flatMap(file => file.signature ? [[file.path, file.signature] as const] : []));
      setMessages(m => [...m, {role: 'system', text: settingsResult.error ? settingsResult.error : `${startupProviderInfo(next)}\n\n${startupContextInfo(files)}`}]);
      await sessionLifecycle.initializeSession().catch(error => {
        const text = error instanceof Error ? error.message : String(error);
        setMessages(m => [...m, {role: 'system', text: `Session disabled: ${text}`}]);
      });
      await refreshSkills().catch(() => undefined);
      if (version) {
        const result = await checkForUpdate({currentVersion: version, packageName: '@denizokcu/haze'}).catch(() => undefined);
        if (result?.isOutdated) {
          setMessages(m => [...m, {role: 'system', text: `A new version of haze is available: ${result.latestVersion} (you have ${version}). Update with:  npm i -g @denizokcu/haze`}]);
        }
      }
    })().catch(() => undefined);
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
    setLiveMessagesState,
    setTokenUsage,
    debugLog,
    showPersistenceWarning,
  });
  const {clearConversation, compactConversation} = sessionLifecycle;

  async function openSessionPicker() {
    await sessionRecorderRef.current?.flush().catch(showPersistenceWarning);
    const next = await listSessions();
    setSessions(next);
    setSelectedSessionId(undefined);
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
      setSessions([]);
      setSelectedSessionId(undefined);
      setModelProviderFilter(undefined);
      setDiscoveredModels([]);
      setSuggestedModels([]);
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
    sessions, selectedSessionId,
    providerDraft, lspDraft, mcpDraft, skillDraft,
    setMode, setSettings,
    setSelectedProviderName, setSelectedSkillName, setSelectedLspName, setSelectedMcpName, setSelectedSessionId,
    resumeSessionById: sessionLifecycle.resumeSessionById,
    forkSessionById: sessionLifecycle.forkSessionById,
    setModelProviderFilter, setProviderDraft, setSkillDraft, setLspDraft, setMcpDraft, setDiscoveredModels, setSuggestedModels,
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
        await sessionLifecycle.startNewSession('New session started.');
      },
      resumeSession: noSession ? undefined : async id => {
        if (id) await sessionLifecycle.resumeSessionById(id);
        else await openSessionPicker();
      },
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
      await teardownBackgroundProcesses().catch(showPersistenceWarning);
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
      const preparedFollowUp = await prepareUserInput(next);
      if (!preparedFollowUp) continue;
      await runSingleAgentTurn(preparedFollowUp.value, preparedFollowUp.displayValue, preparedFollowUp.options);
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
  const {staticItems: staticTranscriptItems, streamingItems} = partitionDisplayMessages([...visible, ...activeLiveMessages]);
  const activeSelection = activeModel(settings);
  const placeholder = placeholderForMode(mode, busy);
  const activeModelName = activeSelection ? `${activeSelection.provider.name}:${activeSelection.model}` : 'unconfigured';
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
  const busyElapsed = busyElapsedLabel(turnStartedAtRef.current);
  const contentWidth = Math.max(1, width - 2);

  return <Box flexDirection="column" paddingX={1}>
    <Static items={staticItems}>
      {item => item.kind === 'header'
        ? <Header key={item.key} subtitle={item.subtitle} version={version} />
        : item.kind === 'assistant-markdown'
          ? <AssistantMarkdownChunkView key={item.key} message={item.message} content={item.content} width={contentWidth} first={item.first} final={item.final} />
          : <MessageView key={item.key} message={item.message} width={contentWidth} />}
    </Static>
    {streamingItems.length > 0 && <Box flexDirection="column" flexShrink={0}>
      {streamingItems.map(item => <MessageView key={item.key} message={item.message} width={contentWidth} showHeader={item.showHeader} />)}
    </Box>}
    {debug && debugLogs.length > 0 && <Box flexDirection="column" flexShrink={0} marginBottom={1} borderStyle="round" borderColor={theme.muted} paddingX={1}>
      <Text color={theme.muted} bold>Debug</Text>
      {debugLogs.map((line, index) => <Text key={index} color={theme.muted}>• {line}</Text>)}
    </Box>}
    {queuedFollowUps.length > 0 && <Box flexDirection="column" flexShrink={0} marginBottom={1}>
      <Text color={theme.muted}>Queued follow-ups:</Text>
      {queuedFollowUps.map((item, index) => <Text key={`${index}-${item}`} color={theme.muted}>  {index + 1}. {item}</Text>)}
    </Box>}
    {visibleTasks.length > 0 && <Box flexDirection="column" flexShrink={0} marginBottom={1}>
      <TaskBar tasks={visibleTasks} width={contentWidth} expanded={tasksExpanded} padding={taskBarPadding} />
    </Box>}
    {busy && <BusyBar label={busyLabel} elapsed={busyElapsed} tip={showingTip ? TIPS[tipIndex] : undefined} />}
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
          width={Math.max(20, contentWidth - 4)}
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
      {tokenUsage.costUsd != null && <Text color={theme.muted}>  cost={formatCostUsd(tokenUsage.costUsd)} (estimated from configured model pricing)</Text>}
    </Box>}
    <Box flexShrink={0} justifyContent="space-between">
      <Box flexDirection="column" flexShrink={1} minWidth={0}>
        <Text color={theme.muted} wrap="truncate-end">{workspaceLabel}</Text>
        <Text color={theme.muted} wrap="truncate-end">{metrics.statusDetailLabel}</Text>
      </Box>
      <Box flexShrink={0} marginLeft={2}>
        <Text color={theme.muted} wrap="truncate-start">{activeModelName}</Text>
      </Box>
    </Box>
  </Box>;
}

export async function chatCommand(options: ChatOptions = {}) {
  if (process.stdout.isTTY) {
    process.stdout.write('\u001B[2J\u001B[3J\u001B[H');
  }
  await clearTasksFromStore().catch(() => undefined);
  const app = render(<ChatScreen debug={options.debug} version={options.version} continueSession={options.continueSession} resumeSessionId={options.resumeSessionId} noSession={options.noSession} />);
  await app.waitUntilExit();
  await teardownBackgroundProcesses().catch(() => undefined);
  await clearTasksFromStore().catch(() => undefined);
}
