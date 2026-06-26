import type {ToolFailureReasonCode} from '../toolResultTypes.js';

/**
 * Error thrown by built-in tools to carry a structured failure reason and an
 * optional recovery hint (next tool + input). Caught and normalized into a
 * structured tool-result object by {@link structuredToolFailure}.
 */
export class HazeToolError extends Error {
  reasonCode: ToolFailureReasonCode;
  recoveryTool?: string;
  recoveryInput?: unknown;

  constructor(message: string, reasonCode: ToolFailureReasonCode, options?: {recoveryTool?: string; recoveryInput?: unknown}) {
    super(message);
    this.name = 'HazeToolError';
    this.reasonCode = reasonCode;
    this.recoveryTool = options?.recoveryTool;
    this.recoveryInput = options?.recoveryInput;
  }
}

/**
 * Normalize a thrown error (or raw value) into the structured `{ok: false}`
 * tool-result shape every built-in tool returns on failure. Honors
 * `HazeToolError` reason/recovery hints when present and lets callers override
 * the reason code (e.g. fetch's `blocked_url`).
 */
export function structuredToolFailure(toolName: string, error: unknown, suggestedNextStep: string, pathForError?: string, options?: {reasonCode?: ToolFailureReasonCode; recoveryTool?: string; recoveryInput?: unknown}) {
  const message = error instanceof Error ? error.message : String(error);
  const hazeError = error instanceof HazeToolError ? error : undefined;
  return {
    ok: false,
    toolName,
    path: pathForError,
    error: message,
    reasonCode: options?.reasonCode ?? hazeError?.reasonCode,
    recoverable: true,
    suggestedNextStep,
    recoveryTool: options?.recoveryTool ?? hazeError?.recoveryTool,
    recoveryInput: options?.recoveryInput ?? hazeError?.recoveryInput,
  };
}
