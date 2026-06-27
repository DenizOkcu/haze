export type AgentEvent =
  | {type: 'turn_start'; request: string; at: string}
  | {type: 'turn_end'; request: string; at: string; status: 'complete' | 'aborted' | 'failed'}
  | {type: 'message_start'; id: string; role: 'assistant'; at: string}
  | {type: 'message_update'; id: string; text: string; at: string}
  | {type: 'message_end'; id: string; text: string; at: string; hidden?: boolean}
  | {type: 'tool_start'; id: string; name: string; input: unknown; at: string}
  | {type: 'tool_end'; id: string; name: string; success: boolean; output?: unknown; error?: unknown; durationMs: number; at: string}
  | {type: 'retry'; attempt: number; maxAttempts: number; delayMs: number; error: string; at: string}
  | {type: 'fallback'; provider: string; model: string; at: string}
  | {type: 'context_overflow'; recovered: boolean; error: string; at: string};

export type AgentEventSink = (event: AgentEvent) => void;
export type AgentEventInput = AgentEvent extends infer Event ? Event extends {at: string} ? Omit<Event, 'at'> : never : never;

export function agentEvent(event: AgentEventInput): AgentEvent {
  return {...event, at: new Date().toISOString()} as AgentEvent;
}
