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

/**
 * Read a string field from an `unknown` tool input object. Returns undefined
 * for non-objects, missing keys, or non-string values.
 */
export function toolInputField(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input == null || !(key in input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Deduplicated read-only tool calls return a `{duplicateSkipped: true}` marker
 * instead of re-running. Lets observers treat them as no-ops.
 */
export function isDuplicateSkippedOutput(output: unknown): boolean {
  return typeof output === 'object' && output != null && 'duplicateSkipped' in output && (output as {duplicateSkipped?: unknown}).duplicateSkipped === true;
}
