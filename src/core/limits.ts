/**
 * Centralized output/resource limits.
 *
 * Byte budgets below bound work performed (process output, file reads, JSONL
 * lines, LSP frames/headers/buffers, stored tool-output handles, skill files,
 * exact-mutation size); the model-facing character caps bound returned/persisted
 * text so callers cite a named constant instead of a magic number (CR-014).
 *
 * Changing a value changes availability/memory behavior; mention user-visible
 * changes in `CHANGELOG.md` and docs.
 */

export const BASH_STREAM_BYTES = 2 * 1024 * 1024;
export const BACKGROUND_PROCESS_OUTPUT_BYTES = 256 * 1024;
export const GREP_STREAM_BYTES = 8 * 1024 * 1024;
export const PROCESS_STDERR_BYTES = 64 * 1024;
export const TOOL_OUTPUT_ENTRY_BYTES = 2 * 1024 * 1024;
export const TOOL_OUTPUT_TOTAL_BYTES = 16 * 1024 * 1024;
export const LSP_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const LSP_HEADER_BYTES = 16 * 1024;
export const LSP_FRAME_BYTES = 8 * 1024 * 1024;
export const LSP_BUFFER_BYTES = LSP_FRAME_BYTES + LSP_HEADER_BYTES;
export const SKILL_MARKDOWN_BYTES = 256 * 1024;
export const EXACT_MUTATION_BYTES = 8 * 1024 * 1024;
export const JSONL_LINE_BYTES = 4 * 1024 * 1024;
export const TEXT_LINE_BYTES = 1024 * 1024;
/** Maximum byte size of a prompt read from piped stdin. */
export const STDIN_PROMPT_BYTES = 256 * 1024;
/** Maximum size of one user-attached image (checked before the read). */
export const IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Maximum number of image attachments in a single user message. */
export const IMAGE_ATTACHMENTS_PER_MESSAGE = 4;

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
/** Bounded older-transcript budget sent to the model for LLM-summarized /compact (F-09). */
export const COMPACTION_LLM_TRANSCRIPT_CHARS = 60_000;
/** Session JSONL values up to this size stay inline; larger ones become previews. */
export const SESSION_INLINE_VALUE_BYTES = 32 * 1024;
/** Preview length for slimmed session values. */
export const SESSION_PREVIEW_CHARS = 4 * 1024;
/** Strings longer than this are truncated in session snapshots. */
export const SESSION_LARGE_STRING_CHARS = 8 * 1024;
