import type {ModelMessage} from 'ai';
import {appendSessionEntry, type HazeSession, type SessionEntry, type SessionModelSelection} from '../../core/session/sessionStore.js';
import type {GoalLedgerAppend} from '../commands/streaming/goalCheckpoint.js';
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
  const appendEntry = (entry: SessionEntry) => {
    const session = getSession();
    if (!session) return;
    void writer.append({session, entry});
  };

  // Full-history snapshot coalescing (RH-008). conversation_snapshot and
  // work_state_snapshot entries are large and only the latest of each is ever
  // restored. A long autonomous turn calls setConversation many times; writing
  // the full history on every call makes the JSONL grow quadratically. Keep at
  // most one snapshot of each type in flight: while a write is pending, newer
  // snapshots replace the pending one so only the latest reaches disk.
  let pendingConversation: {session: HazeSession; messages: ModelMessage[]; at: string; selection?: SessionModelSelection} | undefined;
  let pendingWorkState: {state: WorkState; at: string} | undefined;
  let conversationInFlight = false;
  let workStateInFlight = false;

  const writeConversation = (snapshot: {session: HazeSession; messages: ModelMessage[]; at: string; selection?: SessionModelSelection}) => {
    const {session, messages, at, selection} = snapshot;
    conversationInFlight = true;
    void writer
      .append({session, entry: {type: 'conversation_snapshot', at, messages, ...(selection ? {selection} : {})}})
      .catch(() => undefined)
      .finally(() => {
        conversationInFlight = false;
        drainConversation();
      });
  };
  const drainConversation = () => {
    if (conversationInFlight || !pendingConversation) return;
    const snapshot = pendingConversation;
    pendingConversation = undefined;
    writeConversation(snapshot);
  };
  const writeWorkState = (snapshot: {state: WorkState; at: string}) => {
    const session = getSession();
    if (!session) return;
    workStateInFlight = true;
    void writer
      .append({session, entry: {type: 'work_state_snapshot', at: snapshot.at, state: snapshot.state}})
      .catch(() => undefined)
      .finally(() => {
        workStateInFlight = false;
        drainWorkState();
      });
  };
  const drainWorkState = () => {
    if (workStateInFlight || !pendingWorkState) return;
    const snapshot = pendingWorkState;
    pendingWorkState = undefined;
    writeWorkState(snapshot);
  };

  let lastModelSelection: ({session: HazeSession} & SessionModelSelection) | undefined;
  function recordModelSelection(selection: SessionModelSelection) {
    const session = getSession();
    if (!session || (lastModelSelection?.session === session && lastModelSelection.provider === selection.provider && lastModelSelection.model === selection.model && lastModelSelection.endpointFingerprint === selection.endpointFingerprint)) return;
    lastModelSelection = {session, ...selection};
    appendEntry({type: 'model_selection', at: new Date().toISOString(), selection});
  }
  return {
    recordModelSelection,
    recordModelTransition(messages: ModelMessage[], selection: SessionModelSelection) {
      // Snapshot and selection must survive a crash together. Drop superseded
      // queued snapshots before enqueuing the atomic transition record.
      const session = getSession();
      if (!session) return;
      if (pendingConversation && pendingConversation.session !== session) {
        const pending = pendingConversation;
        void writer.append({session: pending.session, entry: {type: 'conversation_snapshot', at: pending.at, messages: pending.messages, ...(pending.selection ? {selection: pending.selection} : {})}}).catch(() => undefined);
      }
      pendingConversation = undefined;
      appendEntry({type: 'conversation_snapshot', at: new Date().toISOString(), messages, selection});
      lastModelSelection = {session, ...selection};
    },
    recordUiMessage(message: Message) {
      appendEntry({type: 'ui_message', at: new Date().toISOString(), role: message.role, text: message.text});
    },
    recordConversation(messages: ModelMessage[]) {
      const session = getSession();
      if (!session) return;
      const selection = lastModelSelection?.session === session ? {provider: lastModelSelection.provider, model: lastModelSelection.model, ...(lastModelSelection.endpointFingerprint ? {endpointFingerprint: lastModelSelection.endpointFingerprint} : {})} : undefined;
      pendingConversation = {session, messages, at: new Date().toISOString(), ...(selection ? {selection} : {})};
      drainConversation();
    },
    recordWorkState(state: WorkState) {
      pendingWorkState = {state, at: new Date().toISOString()};
      drainWorkState();
    },
    recordEvent(event: AgentEvent) {
      // message_update is transient UI progress; never persist it (RH-006). It is
      // dropped here, before JSON.stringify, so high-volume streaming updates do
      // not pay serialization or queueing cost in the durable writer.
      if (event.type === 'message_update') return;
      appendEntry({type: 'event', at: event.at, name: event.type, text: JSON.stringify(event)});
    },
    // Durable goal-ledger append (P1): the supervisor calls this once per
    // boundary (start/continue/end); the append-only frontier is the last
    // non-terminal entry, and a truncated tail line parses as absent.
    recordGoalEntry(entry: GoalLedgerAppend) {
      appendEntry({type: 'goal', at: new Date().toISOString(), ...entry} as SessionEntry);
    },
    recordNamedEvent(name: string, text: string) {
      appendEntry({type: 'event', at: new Date().toISOString(), name, text});
    },
    // First-class compaction audit entry (Pillar 1.7): what was compacted,
    // when, how, and the summary that replaced it. Snapshots stay the restore
    // source of truth; this entry is the durable narrative.
    recordCompactEntry(entry: {method: 'heuristic' | 'llm'; olderCount: number; keptCount: number; instructions?: string; summary: string}) {
      appendEntry({type: 'compact', at: new Date().toISOString(), method: entry.method, olderCount: entry.olderCount, keptCount: entry.keptCount, ...(entry.instructions ? {instructions: entry.instructions} : {}), summary: entry.summary});
    },
    async flush() {
      // Fold coalesced snapshots into the writer queue, then wait for the queue
      // to drain. Loop because a write completing mid-flush may have queued a
      // newer coalesced snapshot from its finally callback.
      let guard = 0;
      while ((pendingConversation || conversationInFlight || pendingWorkState || workStateInFlight) && guard++ < 1000) {
        drainConversation();
        drainWorkState();
        await writer.flush();
      }
      await writer.flush();
    },
    error() {
      return writer.error();
    },
  };
}

export type SessionRecorder = ReturnType<typeof createSessionRecorder>;
