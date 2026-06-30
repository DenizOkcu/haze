import {storeToolOutput} from '../../core/agent/toolOutputStore.js';

/** Default ceiling for capped tool outputs (bash, fetch). */
export const COMPACT_COMMAND_CHARS = 12_000;
/** Default ceiling for rendered grep output. */
export const GREP_MAX_OUTPUT_CHARS = 30_000;
/** Default ceiling for a single grep match line. */
export const GREP_MAX_LINE_CHARS = 500;
/**
 * Hard ceiling on *raw* command output (stdout/stderr) before any synchronous
 * regex/reducer in the bash-output pipeline sees it. Bounds the worst-case cost
 * of that pipeline so a single huge or pathological command output cannot pin
 * the event loop and freeze the agent (whose idle-timeout shares the same loop
 * and therefore can never fire while it is blocked). Generous enough that normal
 * outputs pass through untouched.
 */
export const MAX_RAW_OUTPUT_CHARS = 200_000;

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

/**
 * Truncate *raw* command output to `maxChars` (head + tail + marker) before it
 * enters the synchronous reduction/regex pipeline. Unlike {@link compactStoredOutput}
 * this stores nothing behind a handle — it is a pure safety bound whose only job
 * is to keep the event loop responsive regardless of what a command emitted.
 */
export function capRawOutput(text: string, maxChars = MAX_RAW_OUTPUT_CHARS) {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.5);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n[... ${text.length - maxChars} characters of raw output truncated to bound processing cost ...]\n${text.slice(-tail)}`;
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
  // Estimate the serialized size incrementally to keep this O(n) rather than
  // re-serializing the whole accumulated array on every iteration (O(n²)).
  // We approximate the JSON shape: a `[`/`]` wrapper, per-object structural
  // overhead (keys, quotes, braces, separators), and the field values
  // themselves. This is slightly tighter than a real `JSON.stringify` would
  // be (it ignores escaping of `"`, `\`, and control chars in `content`),
  // which is the safe direction for a soft truncation ceiling.
  const itemSeparatorChars = 2; // `, ` between objects in the serialized array.
  const objectOverheadChars = 30; // keys + quotes + braces + structural separators.
  const arrayWrapperChars = 2; // the surrounding `[` and `]`.
  let estimatedSize = arrayWrapperChars;
  for (const match of matches) {
    const line = compactLine(match.content);
    lineTruncated = lineTruncated || line.truncated;
    const lineText = line.text;
    const itemSize = objectOverheadChars + match.file.length + String(match.line).length + lineText.length;
    if (estimatedSize + itemSize > maxChars) {
      omittedResultLines = matches.length - compacted.length;
      break;
    }
    estimatedSize += itemSize + itemSeparatorChars;
    compacted.push({...match, content: lineText});
  }
  return {matches: compacted, lineTruncated, omittedResultLines, outputTruncated: omittedResultLines > 0 || lineTruncated};
}
