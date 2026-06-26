import type {ModelMessage} from 'ai';
import {appendSessionEntry, type HazeSession} from '../../core/session/sessionStore.js';
import type {AgentEvent} from '../../core/agent/events.js';
import type {WorkState} from '../../core/agent/workState.js';
import type {Message} from '../commands/streaming.js';

function appendFireAndForget(session: HazeSession | undefined, entry: Parameters<typeof appendSessionEntry>[1]) {
  if (session) void appendSessionEntry(session, entry).catch(() => undefined);
}

export function createSessionRecorder(getSession: () => HazeSession | undefined) {
  return {
    recordUiMessage(message: Message) {
      appendFireAndForget(getSession(), {type: 'ui_message', at: new Date().toISOString(), role: message.role, text: message.text});
    },
    recordConversation(messages: ModelMessage[]) {
      appendFireAndForget(getSession(), {type: 'conversation_snapshot', at: new Date().toISOString(), messages});
    },
    recordWorkState(state: WorkState) {
      appendFireAndForget(getSession(), {type: 'work_state_snapshot', at: new Date().toISOString(), state});
    },
    recordEvent(event: AgentEvent) {
      appendFireAndForget(getSession(), {type: 'event', at: event.at, name: event.type, text: JSON.stringify(event)});
    },
  };
}

export type SessionRecorder = ReturnType<typeof createSessionRecorder>;
