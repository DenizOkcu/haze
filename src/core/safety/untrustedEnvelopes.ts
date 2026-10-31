/**
 * Shared closing-tag escaper for untrusted-content envelopes (R2-HZ-11).
 *
 * Every producer that interpolates untrusted text inside a labeled container
 * (`<web_content>`, `<mcp_result>`, `<project_instructions>`,
 * `<project_context>`, `<haze_compaction>`) must neutralize forged closers in
 * the payload: a closing tag inside the content would end the envelope early
 * in the model's perception and promote the trailing payload to a
 * higher-trust position. The match is variant-tolerant (case differences,
 * whitespace inside the tag, a newline before `>`) because lenient XML
 * readers — and models — accept those spellings as closers too; exact-match
 * `replaceAll` replacements pass them through unescaped.
 *
 * One helper for all envelope producers: no ad-hoc per-site escapes.
 */

const ENVELOPE_CLOSER = /<\/\s*(web_content|mcp_result|project_instructions|project_context|haze_compaction)\s*>/gi;

/**
 * Escape every envelope-closing-tag variant in `content` so the payload
 * cannot forge an envelope boundary. The escape breaks the tag open (`<\/`)
 * while leaving the visible text recognizable; envelope parsers that reverse
 * the exact form keep working because the producer's own closer is intact.
 */
export function escapeEnvelopeClosers(content: string): string {
  return content.replace(ENVELOPE_CLOSER, closer => closer.replace('</', '<\\/'));
}
