import type {Message} from '../commands/streaming.js';
import type {ChatScreenDeps} from './screenDeps.js';

/** Finalize a formerly-live message into the append-only transcript and session record. */
export function finalizeMessage(deps: ChatScreenDeps, message: Message) {
  if (message.hidden || deps.sealedRef.current) return;
  const ordered = deps.withDisplayOrder(message);
  deps.setMessages(m => [...m, ordered]);
  deps.sessionRecorderRef.current?.recordUiMessage(ordered);
}
