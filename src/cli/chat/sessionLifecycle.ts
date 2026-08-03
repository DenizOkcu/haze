import type {ModelMessage} from 'ai';
import type {ContextFile} from '../../config/contextFiles.js';
import type {WorkState} from '../../core/agent/workState.js';
import {compactModelMessages} from '../../core/agent/compaction.js';
import {clearToolOutputs} from '../../core/agent/toolOutputStore.js';
import {createSession, findSession, forkSession, formatSession, latestSession, restoreSessionState, type HazeSession} from '../../core/session/sessionStore.js';
import {createLog as createLlmLog, endLog as endLlmLog, type LlmLog} from '../../core/log/llmLog.js';
import type {Message, TokenUsage} from '../commands/streaming.js';
import type {SessionRecorder} from './sessionRecorder.js';
import {displayMessagesFromConversation, estimateConversationTokens} from './chatMetrics.js';
import {EMPTY_TOKEN_USAGE} from './turnState.js';

/**
 * Session lifecycle controller extracted from `chat.tsx` (CR-006): session
 * init/continue/resume/new/clear/compact live here; the component keeps refs,
 * state setters, and render work. Uses plain `{current}` holders so it works
 * with React refs without importing React.
 */
export interface SessionLifecycleDeps {
  version?: string;
  continueSession: boolean;
  resumeSessionId?: string;
  noSession: boolean;
  debug: boolean;
  contextFiles: () => ContextFile[];
  sessionRef: {current: HazeSession | undefined};
  sessionRecorder: () => SessionRecorder | undefined;
  sessionStartRef: {current: Date};
  conversationRef: {current: ModelMessage[]};
  workStateRef: {current: WorkState | undefined};
  lastAssistantTextRef: {current: string};
  llmLogRef: {current: LlmLog | undefined};
  contextFileSignaturesRef: {current: Map<string, string>};
  setMessages: (updater: (messages: Message[]) => Message[]) => void;
  setLiveMessagesState: (updater: (messages: Message[]) => Message[]) => void;
  setTokenUsage: (usage: TokenUsage) => void;
  debugLog: (line: string) => void;
  showPersistenceWarning: (error: unknown) => void;
}

export interface SessionLifecycle {
  initializeSession: () => Promise<void>;
  startNewSession: (message?: string) => Promise<void>;
  resumeLatestSession: () => Promise<void>;
  resumeSessionById: (id: string) => Promise<boolean>;
  forkSessionById: (id: string) => Promise<boolean>;
  clearConversation: () => Promise<void>;
  compactConversation: (instructions?: string) => boolean;
}

export function createSessionLifecycle(deps: SessionLifecycleDeps): SessionLifecycle {
  async function startNewLog() {
    if (!deps.debug) return undefined;
    if (deps.llmLogRef.current) {
      await endLlmLog(deps.llmLogRef.current).catch(deps.showPersistenceWarning);
    }
    const log = await createLlmLog();
    deps.llmLogRef.current = log;
    return log;
  }

  async function startNewSession(message = 'Started a new session.') {
    await deps.sessionRecorder()?.flush().catch(deps.showPersistenceWarning);
    clearToolOutputs();
    deps.contextFileSignaturesRef.current = new Map(deps.contextFiles().flatMap(file => file.signature ? [[file.path, file.signature] as const] : []));
    deps.workStateRef.current = undefined;
    deps.sessionStartRef.current = new Date();
    if (deps.noSession) {
      deps.sessionRef.current = undefined;
      return;
    }
    const session = await createSession({hazeVersion: deps.version});
    deps.sessionRef.current = session;
    deps.setTokenUsage({...EMPTY_TOKEN_USAGE});
    await startNewLog();
    deps.setMessages(m => [...m, {role: 'system', text: `${message}\nSession saved: ${session.file}`}]);
  }

  async function resumeSession(session: HazeSession, replaceTranscript: boolean) {
    const {messages: conversation, workState, parseErrors} = await restoreSessionState(session);
    deps.sessionRef.current = session;
    deps.conversationRef.current = conversation;
    deps.setLiveMessagesState(() => []);
    const restoredMessages = displayMessagesFromConversation(conversation);
    deps.setTokenUsage({...EMPTY_TOKEN_USAGE, messages: estimateConversationTokens(restoredMessages).input, outputEstimate: estimateConversationTokens(restoredMessages).output});
    deps.workStateRef.current = workState;
    for (const error of parseErrors) {
      deps.debugLog(`Session parse error: ${error}`);
    }
    deps.setMessages(messages => {
      const restored = [{role: 'system', text: `Resumed session: ${formatSession(session)}`} as Message, ...restoredMessages];
      return replaceTranscript ? restored : [...messages, ...restored];
    });
  }

  return {
    async initializeSession() {
      if (deps.noSession) return;
      if (deps.resumeSessionId) {
        const session = await findSession(deps.resumeSessionId);
        if (!session) throw new Error(`No session named ${deps.resumeSessionId} exists for this workspace.`);
        await resumeSession(session, false);
        deps.sessionStartRef.current = new Date();
        await startNewLog();
        return;
      }
      if (deps.continueSession) {
        const session = await latestSession();
        if (session) {
          await resumeSession(session, false);
          deps.sessionStartRef.current = new Date();
          await startNewLog();
          return;
        }
      }
      await startNewSession(deps.continueSession ? 'No previous session found. Started a new session.' : 'Started a new session.');
    },

    startNewSession,

    async resumeLatestSession() {
      await deps.sessionRecorder()?.flush().catch(deps.showPersistenceWarning);
      const session = await latestSession();
      if (!session) {
        deps.setMessages(m => [...m, {role: 'system', text: 'No previous session found for this workspace.'}]);
        return;
      }
      clearToolOutputs();
      await resumeSession(session, true);
      deps.sessionStartRef.current = new Date();
      await startNewLog();
    },

    async resumeSessionById(id: string) {
      await deps.sessionRecorder()?.flush().catch(deps.showPersistenceWarning);
      const session = await findSession(id);
      if (!session) {
        deps.setMessages(m => [...m, {role: 'system', text: `No session named ${id} exists for this workspace.`}]);
        return false;
      }
      clearToolOutputs();
      await resumeSession(session, true);
      deps.sessionStartRef.current = new Date();
      await startNewLog();
      return true;
    },

    async forkSessionById(id: string) {
      await deps.sessionRecorder()?.flush().catch(deps.showPersistenceWarning);
      const source = await findSession(id);
      if (!source) {
        deps.setMessages(m => [...m, {role: 'system', text: `No session named ${id} exists for this workspace.`}]);
        return false;
      }
      let forked: Awaited<ReturnType<typeof forkSession>>;
      try {
        forked = await forkSession(source, {hazeVersion: deps.version});
      } catch (error) {
        deps.setMessages(m => [...m, {role: 'system', text: error instanceof Error ? error.message : String(error)}]);
        return false;
      }
      const {session, parseErrors} = forked;
      for (const error of parseErrors) deps.debugLog(`Session parse error: ${error}`);
      clearToolOutputs();
      await resumeSession(session, true);
      deps.sessionStartRef.current = new Date();
      await startNewLog();
      deps.setMessages(m => [...m, {role: 'system', text: `Forked from session ${id}. The original was left unchanged.`}]);
      return true;
    },

    async clearConversation() {
      clearToolOutputs();
      deps.conversationRef.current = [];
      deps.lastAssistantTextRef.current = '';
      deps.setTokenUsage({...EMPTY_TOKEN_USAGE});
      deps.workStateRef.current = undefined;
      deps.setLiveMessagesState(() => []);
      deps.setMessages(() => [{role: 'system', text: 'Cleared. The void is productive.'}]);
      deps.sessionRecorder()?.recordNamedEvent('clear', 'Conversation cleared');
      await deps.sessionRecorder()?.flush().catch(deps.showPersistenceWarning);
      await startNewLog().catch(deps.showPersistenceWarning);
    },

    compactConversation(instructions?: string) {
      const result = compactModelMessages(deps.conversationRef.current, {instructions, tokenBudget: 40_000, workState: deps.workStateRef.current});
      if (!result.compacted) {
        deps.setMessages(m => [...m, {role: 'system', text: `Compaction skipped: only ${result.keptCount} model messages in context.`}]);
        return false;
      }
      deps.conversationRef.current = result.messages;
      deps.sessionRecorder()?.recordNamedEvent('compact', `Compacted ${result.olderCount} messages; kept ${result.keptCount}.`);
      deps.sessionRecorder()?.recordConversation(result.messages);
      deps.setMessages(m => [...m, {role: 'system', text: `Compacted context: condensed ${result.olderCount} older model messages into a bounded excerpt and kept the last ${result.keptCount}.`}]);
      return true;
    },
  };
}
