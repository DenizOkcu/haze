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
  /** Overrides the caller's generic next step when this error knows its own recovery (e.g. secret-file refusals). */
  suggestedNextStep?: string;
  /** Overrides the default `recoverable: true` for terminal refusals the model must not retry. */
  recoverable?: boolean;

  constructor(message: string, reasonCode: ToolFailureReasonCode, options?: {recoveryTool?: string; recoveryInput?: unknown; suggestedNextStep?: string; recoverable?: boolean}) {
    super(message);
    this.name = 'HazeToolError';
    this.reasonCode = reasonCode;
    this.recoveryTool = options?.recoveryTool;
    this.recoveryInput = options?.recoveryInput;
    this.suggestedNextStep = options?.suggestedNextStep;
    this.recoverable = options?.recoverable;
  }
}

/**
 * Normalize a thrown error (or raw value) into the structured `{ok: false}`
 * tool-result shape every built-in tool returns on failure. Honors
 * `HazeToolError` reason/recovery hints when present and lets callers override
 * the reason code (e.g. fetch's `blocked_url`).
 */
export function structuredToolFailure(toolName: string, error: unknown, suggestedNextStep: string, pathForError?: string, options?: {reasonCode?: ToolFailureReasonCode; recoveryTool?: string; recoveryInput?: unknown; suggestedPaths?: string[]}) {
  const message = error instanceof Error ? error.message : String(error);
  const hazeError = error instanceof HazeToolError ? error : undefined;
  return {
    ok: false,
    toolName,
    path: pathForError,
    error: message,
    reasonCode: options?.reasonCode ?? hazeError?.reasonCode,
    recoverable: hazeError?.recoverable ?? true,
    suggestedNextStep: hazeError?.suggestedNextStep ?? suggestedNextStep,
    recoveryTool: options?.recoveryTool ?? hazeError?.recoveryTool,
    recoveryInput: options?.recoveryInput ?? hazeError?.recoveryInput,
    ...(options?.suggestedPaths?.length ? {suggestedPaths: options.suggestedPaths} : {}),
  };
}
