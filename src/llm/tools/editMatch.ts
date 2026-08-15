import type {ToolDiffLine} from '../toolResultTypes.js';

/**
 * Pure text-matching and diff helpers for the `editFile` / `replaceLines` tools.
 *
 * `findEditRange` locates `oldText` within a file, tolerating readFile
 * line-number prefixes and trailing-whitespace-only differences (only when the
 * match stays unique). Diff helpers render compact before/after line views.
 */

/** Strip a readFile-style `  123 | ` prefix from each line. */
function stripLineNumberPrefixes(text: string) {
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
  if (text.length === 0) return [];
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

/** Build a compact whole-file diff by trimming unchanged leading/trailing lines. */
export function fileDiff(oldText: string, newText: string): {diff: ToolDiffLine[]; addedLines: number; removedLines: number} {
  if (oldText === newText) return {diff: [], addedLines: 0, removedLines: 0};
  const oldLines = splitDiffLines(oldText);
  const newLines = splitDiffLines(newText);
  let prefixLines = 0;
  while (prefixLines < oldLines.length && prefixLines < newLines.length && oldLines[prefixLines] === newLines[prefixLines]) prefixLines++;
  let suffixLines = 0;
  while (
    suffixLines < oldLines.length - prefixLines
    && suffixLines < newLines.length - prefixLines
    && oldLines[oldLines.length - suffixLines - 1] === newLines[newLines.length - suffixLines - 1]
  ) suffixLines++;

  if (prefixLines === oldLines.length && prefixLines === newLines.length) {
    const lineNumber = Math.max(1, oldLines.length);
    const text = oldLines.at(-1) ?? '';
    const oldHasTrailingNewline = /\r?\n$/.test(oldText);
    const newHasTrailingNewline = /\r?\n$/.test(newText);
    return {
      diff: [
        {type: 'remove', oldLine: lineNumber, text},
        ...(!oldHasTrailingNewline ? [{type: 'meta' as const, text: 'No newline at end of file'}] : []),
        {type: 'add', newLine: lineNumber, text},
        ...(!newHasTrailingNewline ? [{type: 'meta' as const, text: 'No newline at end of file'}] : []),
      ],
      addedLines: 1,
      removedLines: 1,
    };
  }

  const oldChanged = oldLines.slice(prefixLines, oldLines.length - suffixLines);
  const newChanged = newLines.slice(prefixLines, newLines.length - suffixLines);
  const startLine = prefixLines + 1;
  const before = prefixLines > 0
    ? {oldLine: prefixLines, newLine: prefixLines, text: oldLines[prefixLines - 1] ?? ''}
    : undefined;
  const after = suffixLines > 0
    ? {
      oldLine: oldLines.length - suffixLines + 1,
      newLine: newLines.length - suffixLines + 1,
      text: oldLines[oldLines.length - suffixLines] ?? '',
    }
    : undefined;
  return replacementDiff(oldChanged.join('\n'), newChanged.join('\n'), startLine, startLine, {before, after});
}

/** Keep every mutation visible while bounding the inline result size. */
export function boundedDiff(diff: ToolDiffLine[], maxLines: number): {diff: ToolDiffLine[]; truncated: boolean; omittedLines: number} {
  if (diff.length <= maxLines) return {diff, truncated: false, omittedLines: 0};
  const headLines = Math.ceil(maxLines / 2);
  const tailLines = Math.floor(maxLines / 2);
  const omittedLines = diff.length - headLines - tailLines;
  return {
    diff: [...diff.slice(0, headLines), {type: 'gap', omittedLines}, ...diff.slice(diff.length - tailLines)],
    truncated: true,
    omittedLines,
  };
}

/** Render a complete diff as retrievable plain unified-diff-like text. */
export function renderToolDiff(filePath: string, diff: ToolDiffLine[]) {
  const lines = diff.map(line => {
    if (line.type === 'gap') return `... ${line.omittedLines} diff lines omitted ...`;
    if (line.type === 'meta') return `\\ ${line.text}`;
    const marker = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
    return `${marker}${line.text}`;
  });
  return [`--- a/${filePath}`, `+++ b/${filePath}`, ...lines].join('\n');
}
