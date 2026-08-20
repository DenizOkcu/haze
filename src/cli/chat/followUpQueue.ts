import {useRef, useState} from 'react';

/**
 * The follow-up queue for messages submitted while a turn is running (typed
 * input is queued, Esc clears). Extracted from ChatScreen so queue mechanics
 * (ref + mirrored state + transcript notices) live in one place.
 */
export function useFollowUpQueue(addSystemMessage: (text: string) => void) {
  const queueRef = useRef<string[]>([]);
  const [queued, setQueued] = useState<string[]>([]);

  /** Queue a submitted value; empty values are ignored. */
  function queue(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    queueRef.current = [...queueRef.current, trimmed];
    setQueued(queueRef.current);
    addSystemMessage(`Queued follow-up (${queueRef.current.length}): ${trimmed}`);
  }

  /** Dequeue the next follow-up (announcing it), or undefined when empty. */
  function takeNext(): string | undefined {
    const next = queueRef.current[0];
    if (next === undefined) return undefined;
    queueRef.current = queueRef.current.slice(1);
    setQueued(queueRef.current);
    addSystemMessage(`Running queued follow-up: ${next}`);
    return next;
  }

  /** Drop every queued follow-up (user interrupt); reports the clear when anything was dropped. */
  function clear() {
    if (queueRef.current.length === 0) return;
    queueRef.current = [];
    setQueued([]);
    addSystemMessage('Cleared queued follow-ups after interrupt.');
  }

  return {queued, queue, takeNext, clear};
}
