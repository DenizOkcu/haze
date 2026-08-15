import type {TurnCompletionEvidence} from './completionController.js';
import type {EffectiveReasoning, ReasoningLevel} from './reasoningPolicy.js';

export interface AgentStepUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export type AgentEvent =
  | {type: 'turn_start'; request: string; at: string}
  | {type: 'turn_end'; request: string; at: string; status: 'complete' | 'aborted' | 'failed'; evidence?: TurnCompletionEvidence}
  | {type: 'step_start'; attempt: number; step: number; at: string}
  | {type: 'step_end'; attempt: number; step: number; finishReason: string; toolCallCount: number; usage: AgentStepUsage; at: string}
  | {type: 'message_start'; id: string; role: 'assistant'; at: string}
  | {type: 'message_update'; id: string; text: string; at: string}
  | {type: 'message_end'; id: string; text: string; at: string; hidden?: boolean}
  | {type: 'tool_start'; id: string; name: string; input: unknown; at: string}
  | {type: 'tool_end'; id: string; name: string; success: boolean; output?: unknown; errorCode?: string; error?: unknown; durationMs: number; at: string}
  | {type: 'retry'; attempt: number; maxAttempts: number; delayMs: number; error: string; at: string}
  | {type: 'reasoning_policy'; requested?: ReasoningLevel; effective: EffectiveReasoning; reason: string; at: string}
  | {type: 'context_budget'; contextWindowTokens: number; source: 'settings' | 'user-fallback' | 'default-fallback'; at: string}
  | {type: 'context_overflow'; recovered: boolean; error: string; at: string}
  | {type: 'timeout'; phase: 'turn' | 'tool' | 'model-stream'; timeoutMs: number; at: string}
  | {type: 'subagent_state'; id: string; state: 'queued' | 'started' | 'terminal' | 'settled'; mode: string; queued?: number; running: number; queueMs?: number; durationMs?: number; termination?: string; execution?: 'settled' | 'quarantined'; at: string};

export type AgentEventSink = (event: AgentEvent) => void;
export type AgentEventInput = AgentEvent extends infer Event ? Event extends {at: string} ? Omit<Event, 'at'> : never : never;

export function agentEvent(event: AgentEventInput): AgentEvent {
  return {...event, at: new Date().toISOString()} as AgentEvent;
}
