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
