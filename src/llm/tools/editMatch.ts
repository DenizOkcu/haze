import type {ToolDiffLine} from '../toolResultTypes.js';

/**
 * Pure text-matching and diff helpers for the `editFile` / `replaceLines` tools.
 *
 * `findEditRange` locates `oldText` within a file, tolerating readFile
 * line-number prefixes and trailing-whitespace-only differences (only when the
 * match stays unique). Diff helpers render compact before/after line views.
 */

/** Strip a readFile-style `  123 | ` prefix from each line. */
export function stripLineNumberPrefixes(text: string) {
  return text.replace(/^\s*\d+\s+\| ?/gm, '');
}

/** Character offsets of the start of each line (for mapping offsets back to lines). */
function lineStartOffsets(text: string) {
  const offsets = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') offsets.push(index + 1);
  }
  return offsets;
}

function findLineTrimmedRange(original: string, oldText: string) {
  const wantedLines = oldText.replace(/\r\n/g, '\n').split('\n').map(line => line.trimEnd());
  if (wantedLines.at(-1) === '') wantedLines.pop();
  if (wantedLines.length === 0) return undefined;

  const originalLines = original.replace(/\r\n/g, '\n').split('\n');
  const hasTrailingNewline = original.endsWith('\n');
  if (hasTrailingNewline) originalLines.pop();
  const offsets = lineStartOffsets(original);
  const matches: Array<{start: number; end: number}> = [];

  for (let lineIndex = 0; lineIndex <= originalLines.length - wantedLines.length; lineIndex++) {
    const window = originalLines.slice(lineIndex, lineIndex + wantedLines.length).map(line => line.trimEnd());
    if (window.every((line, index) => line === wantedLines[index])) {
      const start = offsets[lineIndex] ?? 0;
      const endLineIndex = lineIndex + wantedLines.length;
      const end = endLineIndex < offsets.length ? (offsets[endLineIndex] ?? original.length) : original.length;
      matches.push({start, end});
    }
  }

  if (matches.length !== 1) return undefined;
  return matches[0];
}

/**
 * Locate `oldText` in `original`. Tries an exact match first, then a
 * line-number-prefix-stripped match, finally a trailing-whitespace-tolerant
 * line match. Returns `multiple` when the text is ambiguous (not unique).
 */
export function findEditRange(original: string, oldText: string) {
  const candidates = [oldText, stripLineNumberPrefixes(oldText)].filter((candidate, index, all) => candidate.length > 0 && all.indexOf(candidate) === index);
  for (const candidate of candidates) {
    const first = original.indexOf(candidate);
    if (first !== -1) {
      const second = original.indexOf(candidate, first + candidate.length);
      if (second !== -1) return {kind: 'multiple' as const};
      return {kind: 'found' as const, start: first, end: first + candidate.length, approximate: candidate !== oldText};
    }
  }
  for (const candidate of candidates) {
    const range = findLineTrimmedRange(original, candidate);
    if (range) return {kind: 'found' as const, ...range, approximate: true};
  }
  return {kind: 'missing' as const};
}

/** Split text into diff lines, dropping a single trailing newline. */
export function splitDiffLines(text: string) {
  const lines = text.split(/\r?\n/);
  if (text.endsWith('\n') || text.endsWith('\r\n')) lines.pop();
  return lines;
}

/** 1-based line number at a character offset. */
export function lineNumberAtOffset(text: string, offset: number) {
  let line = 1;
  for (let index = 0; index < offset; index++) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

/**
 * Build a remove/add diff with optional surrounding context lines, plus the
 * added/removed line counts.
 */
export function replacementDiff(
  oldText: string,
  newText: string,
  oldStartLine: number,
  newStartLine: number,
  context?: {before?: {oldLine: number; newLine: number; text: string}; after?: {oldLine: number; newLine: number; text: string}},
): {diff: ToolDiffLine[]; addedLines: number; removedLines: number} {
  const oldLines = splitDiffLines(oldText);
  const newLines = splitDiffLines(newText);
  const diff: ToolDiffLine[] = [];
  if (context?.before) diff.push({type: 'context', ...context.before});
  diff.push(
    ...oldLines.map((text, index) => ({type: 'remove' as const, oldLine: oldStartLine + index, text})),
    ...newLines.map((text, index) => ({type: 'add' as const, newLine: newStartLine + index, text})),
  );
  if (context?.after) diff.push({type: 'context', ...context.after});
  return {diff, addedLines: newLines.length, removedLines: oldLines.length};
}
