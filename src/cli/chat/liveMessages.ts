import {useRef, useState} from 'react';
import type {Message} from '../commands/streaming.js';

/**
 * The dynamic live tail: streaming messages shown below the append-only
 * `<Static>` transcript (streamed assistant text and the active tool group).
 *
 * The tail is a synchronous ref-first store, not plain React state: agent
 * callbacks (addMessage → message_update deltas → the finalizing update that
 * flips `streaming: false`) routinely arrive back-to-back inside one React
 * batch window — a fast or buffered model stream never yields to the scheduler
 * between them. If `liveMessagesRef` were written only inside the state
 * updater, routing decisions made during the burst would read a stale tail:
 * deltas would be dropped and the finalize would misroute, stranding a
 * truncated streaming fragment in the tail forever. Mutations therefore
 * advance the ref immediately (synchronously visible to the next callback)
 * and mirror into state purely for rendering.
 */

export function useLiveMessages(finalizeMessage: (message: Message) => void) {
  const [liveMessages, setLiveMessages] = useState<Message[]>([]);
  const liveMessagesRef = useRef<Message[]>([]);

  function commit(next: Message[]) {
    liveMessagesRef.current = next;
    setLiveMessages(next);
  }

  /** Add a streaming message to the tail. */
  function addStreaming(message: Message) {
    commit([...liveMessagesRef.current, message]);
  }

  /** Patch one live message by id (deltas keep it streaming). */
  function patch(id: string, update: Partial<Message>) {
    const liveMessage = liveMessagesRef.current.find(message => message.id === id);
    if (!liveMessage) return undefined;
    const updated = {...liveMessage, ...update};
    if (updated.streaming === false) {
      commit(liveMessagesRef.current.filter(message => message.id !== id));
      finalizeMessage(updated);
      return updated;
    }
    commit(liveMessagesRef.current.map(message => message.id === id ? updated : message));
    return updated;
  }

  /**
   * Settle every still-streaming message at a turn boundary. Aborted or
   * forcibly settled attempts are quarantined before they can emit the
   * finalizing update, so any message left streaming here would otherwise
   * strand in the dynamic tail forever. Finalized text is preserved verbatim;
   * nothing is lost, it just stops being dynamic.
   */
  function drain(finalize: (message: Message) => void = finalizeMessage) {
    const stranded = liveMessagesRef.current.filter(message => message.streaming);
    if (stranded.length === 0) return;
    commit(liveMessagesRef.current.filter(message => !message.streaming));
    for (const message of stranded) finalize({...message, streaming: false});
  }

  /** Drop the tail (clear/new-session). */
  function clear() {
    if (liveMessagesRef.current.length === 0) return;
    commit([]);
  }

  return {liveMessages, liveMessagesRef, addStreaming, patch, drain, clear};
}
