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

const ENVELOPE_TAGS = ['web_content', 'mcp_result', 'project_instructions', 'project_context', 'haze_compaction'];
const ENVELOPE_CLOSER = new RegExp(`<\\/\\s*(?:${ENVELOPE_TAGS.join('|')})\\s*>`, 'gi');

/** Neutralize one matched closer by breaking the tag open (`<\/`). */
function escapeCloserMatch(closer: string): string {
  return closer.replace('</', '<\\/');
}

/**
 * Escape every envelope-closing-tag variant in `content` so the payload
 * cannot forge an envelope boundary. The escape breaks the tag open (`<\/`)
 * while leaving the visible text recognizable; envelope parsers that reverse
 * the exact form keep working because the producer's own closer is intact.
 */
export function escapeEnvelopeClosers(content: string): string {
  return content.replace(ENVELOPE_CLOSER, escapeCloserMatch);
}

/**
 * Escape every closing-tag variant of one additional labeled container (e.g.
 * `project_skill`) with the same variant tolerance as the five built-in
 * kinds, so ad-hoc per-site `replaceAll` escapes cannot reappear.
 */
export function escapeTagCloserVariants(content: string, tag: string): string {
  if (!/^[a-z0-9_]+$/i.test(tag)) throw new Error(`Invalid envelope tag: ${tag}`);
  return content.replace(new RegExp(`<\\/\\s*${tag}\\s*>`, 'gi'), escapeCloserMatch);
}
