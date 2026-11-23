/**
 * Pure `@mention` detection for the input editor (F04 AC1): finds the `@token`
 * under the text cursor. Lives in `ui/` so the suggestion hook does not import
 * from the CLI layer; the filesystem listing behind the suggestions stays in
 * `cli/chat/fileMentionSuggestions.ts`.
 */

/** Characters allowed inside a `@token` while it is being typed. */
const MENTION_TOKEN_PATTERN = /@[\w./~-]*/g;

export interface MentionContext {
  /** Full token including the leading `@`. */
  token: string;
  /** Index in the source string where the `@` sits. */
  start: number;
  /** Index one past the last char of the token. */
  end: number;
}

/**
 * Find the `@token` (if any) at the given cursor position. The cursor may
 * sit anywhere inside the token or directly after its last char — both
 * count as "inside" so the user can keep typing or completing.
 */
export function detectMentionAtCursor(value: string, cursor: number): MentionContext | undefined {
  for (const match of value.matchAll(MENTION_TOKEN_PATTERN)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (cursor >= start && cursor <= end) return {token: match[0], start, end};
  }
  return undefined;
}
