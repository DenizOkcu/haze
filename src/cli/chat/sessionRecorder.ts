import type {ModelMessage} from 'ai';
import {appendSessionEntry, type HazeSession, type SessionEntry} from '../../core/session/sessionStore.js';
import type {AgentEvent} from '../../core/agent/events.js';
import type {WorkState} from '../../core/agent/workState.js';
import {OrderedFileWriter} from '../../core/persistence/orderedFileWriter.js';
import type {Message} from '../commands/streaming.js';

export function createSessionRecorder(getSession: () => HazeSession | undefined) {
  // Ordered appends and first-error capture come from the shared writer
  // primitive; entries recorded before a session exists are dropped (CR-005).
  const writer = new OrderedFileWriter<{session: HazeSession; entry: SessionEntry}>(
    ({session, entry}) => appendSessionEntry(session, entry),
  );
  const append = (entry: SessionEntry) => {
    const session = getSession();
    if (!session) return;
    void writer.append({session, entry});
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
      await writer.flush();
    },
    error() { return writer.error(); },
  };
}

export type SessionRecorder = ReturnType<typeof createSessionRecorder>;
