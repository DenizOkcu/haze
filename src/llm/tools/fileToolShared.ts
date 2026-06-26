import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {workspaceRelativePath, workspaceRoot} from '../../utils/path.js';
import {HazeToolError} from './failures.js';

const execFile = promisify(execFileCallback);

export const MAX_OUTPUT_CHARS = 50_000;
export const DEFAULT_READ_LINES = 300;
/** Inline diff lines beyond this count are omitted (just the count is returned). */
export const INLINE_DIFF_LINE_LIMIT = 20;

export async function isGitIgnored(absolutePath: string) {
  const relative = workspaceRelativePath(absolutePath);
  if (relative === '.') return false;
  try {
    await execFile('git', ['-C', workspaceRoot(), 'check-ignore', '-q', '--', relative]);
    return true;
  } catch (error) {
    const status = typeof error === 'object' && error != null && 'code' in error ? (error as {code?: unknown}).code : undefined;
    if (status === 1 || status === 128) return false;
    return false;
  }
}

export async function assertNotIgnored(absolutePath: string, inputPath: string, allowIgnored?: boolean) {
  if (!allowIgnored && await isGitIgnored(absolutePath)) {
    throw new HazeToolError(`Path is ignored by .gitignore: ${inputPath}. Set allowIgnored=true only if you explicitly need to access ignored files.`, 'ignored_path', {recoveryTool: 'listFiles'});
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
