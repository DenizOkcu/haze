import wrapAnsi from 'wrap-ansi';

/**
 * Live-region row budgeting.
 *
 * Ink reclaims the terminal with `clearTerminal` (which erases scrollback)
 * whenever the *dynamic* frame grows taller than the viewport, so every dynamic
 * section must be clamped to keep the frame under one screen. These helpers
 * mirror Ink's own line wrapping (`wrapAnsi` with `trim: false, hard: true`) so
 * our row estimates match what Ink actually renders.
 */

/** Wrap one logical line exactly like an Ink `<Text>` with default wrap mode. */
export function wrapLine(line: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  if (line.length === 0) return [''];
  return wrapAnsi(line, safeWidth, {trim: false, hard: true}).split('\n');
}

/** Wrapped row count of a logical line at the given width. */
export function lineRows(line: string, width: number): number {
  return wrapLine(line, width).length;
}

export interface TailClamp {
  text: string;
  /** Wrapped rows hidden above the visible tail (0 when nothing was clamped). */
  hiddenLineCount: number;
}

/**
 * Keep the last `maxLines` wrapped rows of `text`, dropping whole logical lines
 * from the top (a wrapped group is never split). When clamping occurs, one row
 * is reserved for the caller's `⋯ +N lines` indicator. Nothing is lost: the
 * full text is committed verbatim to the static transcript once it settles.
 */
export function clampTextTail(text: string, width: number, maxLines: number): TailClamp {
  if (maxLines < 1) return {text: '', hiddenLineCount: 0};
  const logical = text.replace(/\r\n|\r/g, '\n').split('\n');
  const rows = logical.map(line => lineRows(line, width));
  const total = rows.reduce((sum, count) => sum + count, 0);
  if (total <= maxLines) return {text, hiddenLineCount: 0};

  const visibleBudget = Math.max(1, maxLines - 1); // reserve the indicator row
  let used = 0;
  let start = logical.length;
  while (start > 0) {
    const next = rows[start - 1] ?? 0;
    if (used + next > visibleBudget) break;
    used += next;
    start -= 1;
  }
  const hiddenLineCount = rows.slice(0, start).reduce((sum, count) => sum + count, 0);
  return {text: logical.slice(start).join('\n'), hiddenLineCount};
}
