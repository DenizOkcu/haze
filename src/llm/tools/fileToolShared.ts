import {MAX_OUTPUT_CHARS} from '../../core/limits.js';
import {HazeToolError} from './failures.js';
import {checkGitIgnored, isGitIgnored} from './gitIgnore.js';

export {MAX_OUTPUT_CHARS};
export const DEFAULT_READ_LINES = 300;
/** Maximum real diff rows shown inline; larger diffs retain a head/tail preview and retrieval handle. */
export const INLINE_DIFF_LINE_LIMIT = 8;

// Re-exported so existing import sites keep a single source for ignore checks
// while traversal uses the batched classifier in `gitIgnore.ts` (RH-001).
export {isGitIgnored};

export async function assertNotIgnored(absolutePath: string, inputPath: string, allowIgnored?: boolean) {
  if (allowIgnored) return;
  // Mutations fail closed when ignore status cannot be verified (F-05): reads
  // failing open is right, but silently proceeding into a possibly-ignored
  // path because Git is missing/broken is the unsafe direction for writes.
  const status = await checkGitIgnored(absolutePath);
  if (status === 'ignored') {
    throw new HazeToolError(`Path is ignored by .gitignore: ${inputPath}. Set allowIgnored=true only if you explicitly need to access ignored files.`, 'ignored_path', {recoveryTool: 'listFiles'});
  }
  if (status === 'unknown') {
    throw new HazeToolError(`Could not verify git-ignore status for ${inputPath} (Git unavailable or failed). Set allowIgnored=true to proceed anyway.`, 'ignore_check_unavailable', {recoveryTool: 'listFiles'});
  }
}

const SOURCE_OUTLINE_PATTERNS = [
  /^\s*(?:import|from|export|package|namespace|module|using)\b/,
  /^\s*#\s*include\b/,
  /^\s*(?:public|private|protected|internal|static|async|final|open|sealed|abstract|export\s+)?\s*(?:class|interface|struct|enum|type|trait|record|protocol)\b/,
  /^\s*(?:export\s+)?(?:async\s+)?function\b/,
  /^\s*(?:def|func|fn)\s+[A-Za-z_]/,
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+[A-Za-z_]/,
  /^\s*(?:public|private|protected|internal|static|async|final|override|virtual|abstract)\s+[^=;{}]+\([^)]*\)\s*(?:\{|;|=>)?\s*$/,
];

export function sourceOutlineEntries(lines: string[], startLine: number) {
  return lines
    .map((line, index) => ({lineNumber: startLine + index, text: line}))
    .filter(entry => SOURCE_OUTLINE_PATTERNS.some(pattern => pattern.test(entry.text)));
}
