import type React from 'react';
import type {ModelMessage} from 'ai';
import type {ContextFile} from '../../config/contextFiles.js';
import type {HazeSettings} from '../../config/settings.js';
import type {HazeSession} from '../../core/session/sessionStore.js';
import type {WorkState} from '../../core/agent/workState.js';
import type {LlmLog} from '../../core/log/llmLog.js';
import type {Task} from '../../core/tasks/taskStorage.js';
import type {PromptSession} from '../../llm/systemPrompt.js';
import type {Message, TurnExecutionOptions} from '../commands/streaming.js';
import type {GoalCheckpoint} from '../commands/streaming/goalCheckpoint.js';
import type {Mode} from '../commands/chatModes.js';
import type {SessionRecorder} from './sessionRecorder.js';
import type {useFollowUpQueue} from './followUpQueue.js';
import type {useBusyIndicator} from './busyIndicator.js';
import type {createWizardDispatch} from './wizardDispatch.js';
import type {createSessionLifecycle} from './sessionLifecycle.js';
import type {useTerminalControl} from './terminalControl.js';

/** A genuinely paused goal and what a one-key R resume needs (SU-04). */
export type PausedResume = {
  kind: 'model-stream-idle' | 'incomplete-goal';
  request: string;
  retryAttempt: number;
  checkpoint?: GoalCheckpoint;
  pauseReason?: 'no-progress' | 'goal-deadline' | 'context-exhausted';
};

/** Explicit resume of a paused goal passed into a single agent turn. */
export type ResumeExisting =
  | {kind: 'model-stream-idle'; retryAttempt: number}
  | {kind: 'incomplete-goal'; checkpoint: GoalCheckpoint};

/**
 * The explicit dependency bundle the extracted ChatScreen function bodies
 * (`submitPipeline`, `agentTurnRunner`, `messageFinalize`) receive instead of
 * closing over component scope. Assembled once per render in `chat/ChatScreen.tsx`;
 * refs are shared objects, so call-time reads always see fresh values.
 */
export interface ChatScreenDeps {
  // Mutable turn/session machinery (refs survive rerenders).
  stoppingRef: React.RefObject<boolean>;
  sealedRef: React.RefObject<boolean>;
  quarantineRef: React.RefObject<(() => void) | undefined>;
  activeGoalRef: React.RefObject<Promise<unknown> | undefined>;
  conversationRef: React.RefObject<ModelMessage[]>;
  settingsRef: React.RefObject<HazeSettings>;
  sessionRef: React.RefObject<HazeSession | undefined>;
  sessionRecorderRef: React.RefObject<SessionRecorder | undefined>;
  sessionStartRef: React.RefObject<Date>;
  workStateRef: React.RefObject<WorkState | undefined>;
  lastAssistantTextRef: React.RefObject<string>;
  abortControllerRef: React.RefObject<AbortController | null>;
  llmLogRef: React.RefObject<LlmLog | undefined>;
  contextFileSignaturesRef: React.RefObject<Map<string, string>>;

  // Render-scoped state values.
  settings: HazeSettings;
  settingsError: string | undefined;
  contextFiles: ContextFile[];
  mode: Mode;
  busy: boolean;
  pausedResume: PausedResume | undefined;
  visibleTasks: Task[];

  // State setters.
  setMessages: (updater: React.SetStateAction<Message[]>) => void;
  setSettings: (next: HazeSettings, patch?: HazeSettings) => void;
  setSettingsError: React.Dispatch<React.SetStateAction<string | undefined>>;
  setMode: React.Dispatch<React.SetStateAction<Mode>>;
  setContextFiles: React.Dispatch<React.SetStateAction<ContextFile[]>>;
  setBusy: ReturnType<typeof useBusyIndicator>['setBusy'];
  setBusyLabel: React.Dispatch<React.SetStateAction<string>>;
  setTokenUsage: React.Dispatch<React.SetStateAction<import('../commands/streaming/turnRuntime.js').TokenUsage>>;
  /** Optional so lifecycle-only harnesses need not wire it; the screen always provides it. */
  setContextUsage?: React.Dispatch<React.SetStateAction<import('./turnState.js').ContextUsage>>;
  setFleet: React.Dispatch<React.SetStateAction<import('./chatMetrics.js').FleetStatus | undefined>>;
  setVisibleTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setTaskBarPadding: React.Dispatch<React.SetStateAction<number>>;
  setTasksExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  setPausedResume: React.Dispatch<React.SetStateAction<PausedResume | undefined>>;
  setDebugLogs: React.Dispatch<React.SetStateAction<string[]>>;
  updateWizard: Parameters<typeof createWizardDispatch>[0]['updateWizard'];

  // Component-scope helpers.
  currentModelSelection: () => {provider: string; model: string; endpointFingerprint?: string} | undefined;
  currentPromptSession: () => PromptSession;
  withDisplayOrder: (message: Message) => Message;
  finalizeMessage: (message: Message) => void;
  addStreaming: (message: Message) => void;
  patchLiveMessage: (id: string, update: Partial<Message>) => Message | undefined;
  drainLiveMessages: () => void;
  clearLiveMessages: () => void;
  debugLog: (line: string) => void;
  showPersistenceWarning: (error: unknown) => void;
  skillInvocation: (value: string) => {skill: import('../../skills/types.js').LoadedSkill; args: string} | undefined;
  prepareUserInput: (value: string) => Promise<{value: string; displayValue?: string; options: TurnExecutionOptions} | undefined>;
  doAgentTurn: (value: string, displayValue?: string, turnOptions?: TurnExecutionOptions) => Promise<void>;
  openSessionPicker: () => Promise<void>;
  openPluginPicker: () => Promise<void>;
  refreshSkills: () => Promise<import('../../skills/types.js').LoadedSkill[]>;
  setSessionReasoningOverride: (modelSelector: string, setting: import('../../core/agent/reasoningPolicy.js').StoredReasoningSetting | undefined) => void;
  shutdown: () => Promise<void>;
  followUps: ReturnType<typeof useFollowUpQueue>;
  wizard: ReturnType<typeof createWizardDispatch>;
  sessionLifecycle: ReturnType<typeof createSessionLifecycle>;
  terminalControl: ReturnType<typeof useTerminalControl>;
  noSession: boolean;
}
