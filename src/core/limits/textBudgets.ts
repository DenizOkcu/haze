/**
 * Model-facing text caps (characters). Byte budgets live in `byteBudgets.ts`;
 * these bound the text returned to the model or persisted in previews so
 * callers cite a named constant instead of a magic number (CR-014).
 */

/** Per-page cap for numbered file content returned by readFile/listFiles-style tools. */
export const MAX_OUTPUT_CHARS = 50_000;
/** Default compact cap for stored bash output shown to the model. */
export const COMPACT_COMMAND_CHARS = 12_000;
/** Compact cap for passing-validation summaries. */
export const SHORT_VALIDATION_CHARS = 2_000;
/** Total rendered size cap for grep match output. */
export const GREP_MAX_OUTPUT_CHARS = 30_000;
/** Per-line cap for rendered grep matches. */
export const GREP_MAX_LINE_CHARS = 500;
/** Bounded excerpt of older messages kept by /compact-style compaction. */
export const COMPACTION_OLDER_CHARS = 8_000;
/** Session JSONL values up to this size stay inline; larger ones become previews. */
export const SESSION_INLINE_VALUE_BYTES = 32 * 1024;
/** Preview length for slimmed session values. */
export const SESSION_PREVIEW_CHARS = 4 * 1024;
/** Strings longer than this are truncated in session snapshots. */
export const SESSION_LARGE_STRING_CHARS = 8 * 1024;
