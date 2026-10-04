import {highlight, supportsLanguage} from 'cli-highlight';
import {cellWidth, clipCells} from './textGeometry.js';

/** Map a source path to a cli-highlight language when its extension is known. */
export function languageForPath(filePath: string) {
  const extension = /\.([^./]+)$/.exec(filePath)?.[1]?.toLowerCase();
  if (!extension) return undefined;
  const aliases: Record<string, string> = {
    cjs: 'javascript', cts: 'typescript', htm: 'html', js: 'javascript', md: 'markdown', mjs: 'javascript',
    mts: 'typescript', py: 'python', rb: 'ruby', sh: 'bash', ts: 'typescript', yml: 'yaml',
  };
  const language = aliases[extension] ?? extension;
  return supportsLanguage(language) ? language : undefined;
}

/** Highlight, clip, and pad one source line to an exact terminal width. */
export function highlightedCodeLine(code: string, width: number, language?: string) {
  const safeWidth = Math.max(1, width);
  const singleLine = code.replace(/\t/g, '  ');
  const fitted = cellWidth(singleLine) > safeWidth
    ? `${clipCells(singleLine, safeWidth - 1)}…`
    : singleLine;
  let rendered = fitted;
  try {
    rendered = highlight(fitted, {language: language || undefined, ignoreIllegals: true});
  } catch {
    // Unknown or malformed source still renders as plain text.
  }
  const padding = Math.max(0, safeWidth - cellWidth(rendered));
  return `${rendered}${' '.repeat(padding)}`;
}
