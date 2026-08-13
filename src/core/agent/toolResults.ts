/**
 * Shared, protocol-level predicates and accessors for tool outputs and inputs.
 *
 * Tool results across the codebase carry a loose `{ok?: boolean}` convention
 * (built-in hazeTools, subagent summaries, MCP passthrough). Centralizing these
 * checks keeps the semantics identical everywhere they are used: the dedup gate
 * (`hazeTools`), the work-state observer, the agent turn, and request
 * compaction. Keeping them in `core/agent/` (no `ai`/UI imports) preserves
 * auditability.
 */

/**
 * A structured tool result explicitly reports failure via `{ok: false}`.
 * Returns false for results with no `ok` field (success is implied by the
 * caller's `success` flag) and for non-object outputs.
 */
export function isFailedToolOutput(output: unknown): boolean {
  return typeof output === 'object' && output != null && 'ok' in output && (output as {ok?: unknown}).ok === false;
}

/**
 * Combine the provider success flag with the structured `ok` field. A result
 * counts as OK only when the call succeeded AND did not report `{ok: false}`.
 */
export function toolOutputOk(output: unknown, success: boolean): boolean {
  return success && !isFailedToolOutput(output);
}

export interface SafeToolFailureDetails {
  errorCode?: string;
  error?: string;
}

const MAX_PUBLIC_TOOL_ERROR_CHARS = 500;
const SAFE_ERROR_CODE = /^[a-z0-9_-]{1,80}$/i;

function boundedSingleLine(value: string): string {
  const normalized = value.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_PUBLIC_TOOL_ERROR_CHARS) return normalized;
  return `${normalized.slice(0, MAX_PUBLIC_TOOL_ERROR_CHARS - 1)}…`;
}

/**
 * Extract a bounded diagnostic from Haze's structured failure shape. Generic
 * third-party tool outputs are intentionally ignored because their error fields
 * may contain arbitrary remote content or secrets.
 */
export function safeToolFailureDetails(output: unknown): SafeToolFailureDetails {
  if (typeof output !== 'object' || output == null) return {};
  const value = output as Record<string, unknown>;
  if (value.ok !== false) return {};
  const structuredHazeFailure = typeof value.toolName === 'string' && typeof value.recoverable === 'boolean';
  const reasonCode = typeof value.reasonCode === 'string' && SAFE_ERROR_CODE.test(value.reasonCode) ? value.reasonCode : undefined;
  const missingExecutable = typeof value.missingExecutable === 'string' && value.missingExecutable.trim() ? boundedSingleLine(value.missingExecutable) : undefined;
  const errorCode = reasonCode
    ?? (missingExecutable ? 'missing_executable'
      : value.timedOut === true ? 'command_timed_out'
        : typeof value.exitCode === 'number' && value.exitCode !== 0 ? 'nonzero_exit'
          : typeof value.signal === 'string' ? 'process_signal'
            : undefined);
  // Only the dedicated Haze failure shape guarantees that `error` is a bounded
  // local diagnostic. Bash stderr and third-party fields may contain secrets.
  const error = structuredHazeFailure && typeof value.error === 'string' ? boundedSingleLine(value.error) : undefined;
  return {...(errorCode ? {errorCode} : {}), ...(error ? {error} : {}), ...(missingExecutable ? {missingExecutable} : {})};
}

/**
 * Read a string field from an `unknown` tool input object. Returns undefined
 * for non-objects, missing keys, or non-string values.
 */
export function toolInputField(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input == null || !(key in input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** A mutation failure needs a fresh file read only when it explicitly says so. */
export function requiresReadFileRecovery(value: unknown): boolean {
  return typeof value === 'object' && value != null && 'recoveryTool' in value
    && (value as {recoveryTool?: unknown}).recoveryTool === 'readFile';
}

/**
 * Deduplicated read-only tool calls return a `{duplicateSkipped: true}` marker
 * instead of re-running. Lets observers treat them as no-ops.
 */
export function isDuplicateSkippedOutput(output: unknown): boolean {
  return typeof output === 'object' && output != null && 'duplicateSkipped' in output && (output as {duplicateSkipped?: unknown}).duplicateSkipped === true;
}
