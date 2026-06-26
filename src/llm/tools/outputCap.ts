import {storeToolOutput} from '../../core/agent/toolOutputStore.js';

/** Default ceiling for capped tool outputs (bash, fetch). */
export const COMPACT_COMMAND_CHARS = 12_000;
/** Default ceiling for rendered grep output. */
export const GREP_MAX_OUTPUT_CHARS = 30_000;
/** Default ceiling for a single grep match line. */
export const GREP_MAX_LINE_CHARS = 500;

/**
 * Cap a string to `maxChars` characters, keeping a head + tail and storing the
 * full text behind a `readToolOutput` handle so nothing is lost.
 */
export function compactStoredOutput(text: string, maxChars = COMPACT_COMMAND_CHARS) {
  if (text.length <= maxChars) return {text, truncated: false};
  const handle = storeToolOutput(text);
  const headChars = Math.floor(maxChars * 0.4);
  const tailChars = maxChars - headChars;
  return {
    text: `${text.slice(0, headChars)}\n\n[... ${text.length - maxChars} characters omitted; use readToolOutput with handle ${handle} ...]\n\n${text.slice(-tailChars)}`,
    truncated: true,
    omittedChars: text.length - maxChars,
    handle,
  };
}

/** Truncate a single over-long line in place. */
export function compactLine(text: string, maxChars = GREP_MAX_LINE_CHARS) {
  if (text.length <= maxChars) return {text, truncated: false};
  return {text: `${text.slice(0, Math.max(0, maxChars - 22))}[line truncated]`, truncated: true};
}

/** Render structured grep matches as `file:line:content` lines (context flagged with `-`). */
export function renderGrepMatches(matches: Array<{file: string; line: number; content: string; isContext: boolean}>) {
  return matches.map(match => `${match.file}:${match.line}:${match.isContext ? '-' : ''}${match.content}`).join('\n');
}

/**
 * Compact grep matches to a byte budget, truncating individual lines and
 * dropping trailing matches once the estimated serialized size is exceeded.
 */
export function compactGrepMatches(matches: Array<{file: string; line: number; content: string; isContext: boolean}>, maxChars = GREP_MAX_OUTPUT_CHARS) {
  const compacted: Array<{file: string; line: number; content: string; isContext: boolean}> = [];
  let lineTruncated = false;
  let omittedResultLines = 0;
  for (const match of matches) {
    const line = compactLine(match.content);
    lineTruncated = lineTruncated || line.truncated;
    const next = {...match, content: line.text};
    const estimated = JSON.stringify([...compacted, next]).length;
    if (estimated > maxChars) {
      omittedResultLines = matches.length - compacted.length;
      break;
    }
    compacted.push(next);
  }
  return {matches: compacted, lineTruncated, omittedResultLines, outputTruncated: omittedResultLines > 0 || lineTruncated};
}
