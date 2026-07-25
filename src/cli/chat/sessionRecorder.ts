import type {ModelMessage} from 'ai';
import {appendSessionEntry, type HazeSession} from '../../core/session/sessionStore.js';
import type {AgentEvent} from '../../core/agent/events.js';
import type {WorkState} from '../../core/agent/workState.js';
import type {Message} from '../commands/streaming.js';

export function createSessionRecorder(getSession: () => HazeSession | undefined) {
  let tail: Promise<void> = Promise.resolve();
  let firstError: Error | undefined;
  const append = (entry: Parameters<typeof appendSessionEntry>[1]) => {
    const session = getSession();
    if (!session) return;
    tail = tail.then(() => appendSessionEntry(session, entry)).catch(error => {
      firstError ??= error instanceof Error ? error : new Error(String(error));
    });
  };
  return {
    recordUiMessage(message: Message) {
      append({type: 'ui_message', at: new Date().toISOString(), role: message.role, text: message.text});
    },
    recordConversation(messages: ModelMessage[]) {
      append({type: 'conversation_snapshot', at: new Date().toISOString(), messages});
    },
    recordWorkState(state: WorkState) {
      append({type: 'work_state_snapshot', at: new Date().toISOString(), state});
    },
    recordEvent(event: AgentEvent) {
      append({type: 'event', at: event.at, name: event.type, text: JSON.stringify(event)});
    },
    recordNamedEvent(name: string, text: string) {
      append({type: 'event', at: new Date().toISOString(), name, text});
    },
    async flush() {
      await tail;
      if (firstError) throw firstError;
    },
    error() { return firstError; },
  };
}

export type SessionRecorder = ReturnType<typeof createSessionRecorder>;
