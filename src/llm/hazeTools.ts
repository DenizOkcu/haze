import {execFile as execFileCallback, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tool} from 'ai';
import {rgPath} from '@vscode/ripgrep';
import {z} from 'zod';
import {walkDir} from '../utils/fs.js';
import {workspaceRoot, resolveWorkspacePath, workspaceRelativePath} from '../utils/path.js';
import {classifyBashCommand, isValidationClassification} from '../core/safety/bashClassifier.js';
import {parseValidationOutput} from '../core/validation/outputParser.js';
import type {ToolDiffLine, ToolFailureReasonCode} from './toolResultTypes.js';

const MAX_OUTPUT_CHARS = 50_000;
const execFile = promisify(execFileCallback);

async function isGitIgnored(absolutePath: string) {
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

class HazeToolError extends Error {
  reasonCode: ToolFailureReasonCode;
  recoveryTool?: string;
  recoveryInput?: unknown;

  constructor(message: string, reasonCode: ToolFailureReasonCode, options?: {recoveryTool?: string; recoveryInput?: unknown}) {
    super(message);
    this.name = 'HazeToolError';
    this.reasonCode = reasonCode;
    this.recoveryTool = options?.recoveryTool;
    this.recoveryInput = options?.recoveryInput;
  }
}

async function assertNotIgnored(absolutePath: string, inputPath: string, allowIgnored?: boolean) {
  if (!allowIgnored && await isGitIgnored(absolutePath)) {
    throw new HazeToolError(`Path is ignored by .gitignore: ${inputPath}. Set allowIgnored=true only if you explicitly need to access ignored files.`, 'ignored_path', {recoveryTool: 'listFiles'});
  }
}

function truncate(text: string, maxChars = MAX_OUTPUT_CHARS) {
  if (text.length <= maxChars) return {text, truncated: false};
  return {
    text: text.slice(0, maxChars),
    truncated: true,
    omittedChars: text.length - maxChars,
  };
}

function numberLines(lines: string[], startLine: number) {
  return lines.map((line, index) => `${String(startLine + index).padStart(4, ' ')} | ${line}`).join('\n');
}

function stripLineNumberPrefixes(text: string) {
  return text.replace(/^\s*\d+\s+\| ?/gm, '');
}

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

function findEditRange(original: string, oldText: string) {
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

type ToolExecutionContext = {
  abortSignal?: AbortSignal;
  experimental_context?: unknown;
};

type HazeToolContext = {
  inFlightToolCalls?: Map<string, Promise<unknown>>;
  completedToolCalls?: Map<string, number>;
  mutationEpoch?: number;
  failedMutationPaths?: Set<string>;
  failedMutationReasons?: Map<string, ToolFailureReasonCode | undefined>;
  pathsReadAfterFailedMutation?: Set<string>;
  inFlightMutationPaths?: Set<string>;
};

function toolCallKey(toolName: string, input: unknown) {
  return `${toolName}:${JSON.stringify(input)}`;
}

function hazeContext(context: ToolExecutionContext): HazeToolContext | undefined {
  return typeof context.experimental_context === 'object' && context.experimental_context != null
    ? context.experimental_context as HazeToolContext
    : undefined;
}

function isMutatingTool(toolName: string) {
  return ['editFile', 'replaceLines', 'writeFile'].includes(toolName);
}

function isReadOnlyFileTool(toolName: string) {
  return ['listFiles', 'readFile', 'grep'].includes(toolName);
}

function inputPath(input: unknown) {
  return typeof input === 'object' && input != null && 'path' in input && typeof (input as {path?: unknown}).path === 'string'
    ? (input as {path: string}).path
    : undefined;
}

function isStructuredFailure(value: unknown) {
  return typeof value === 'object' && value != null && 'ok' in value && (value as {ok?: unknown}).ok === false;
}

function structuredToolFailure(toolName: string, error: unknown, suggestedNextStep: string, pathForError?: string, options?: {reasonCode?: ToolFailureReasonCode; recoveryTool?: string; recoveryInput?: unknown; needsConfirmation?: boolean}) {
  const message = error instanceof Error ? error.message : String(error);
  const hazeError = error instanceof HazeToolError ? error : undefined;
  return {
    ok: false,
    toolName,
    path: pathForError,
    error: message,
    reasonCode: options?.reasonCode ?? hazeError?.reasonCode,
    recoverable: true,
    suggestedNextStep,
    recoveryTool: options?.recoveryTool ?? hazeError?.recoveryTool,
    recoveryInput: options?.recoveryInput ?? hazeError?.recoveryInput,
    needsConfirmation: options?.needsConfirmation,
  };
}

const INLINE_DIFF_LINE_LIMIT = 20;

function splitDiffLines(text: string) {
  const lines = text.split(/\r?\n/);
  if (text.endsWith('\n') || text.endsWith('\r\n')) lines.pop();
  return lines;
}

function lineNumberAtOffset(text: string, offset: number) {
  let line = 1;
  for (let index = 0; index < offset; index++) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function replacementDiff(
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

async function runDedupedTool<T>(toolName: string, input: unknown, context: ToolExecutionContext, execute: () => Promise<T>): Promise<T | {ok: true; duplicateSkipped: true; toolName: string; reason: string}> {
  const ctx = hazeContext(context);
  if (!ctx) return execute();
  ctx.inFlightToolCalls ??= new Map();
  ctx.completedToolCalls ??= new Map();
  ctx.failedMutationPaths ??= new Set();
  ctx.failedMutationReasons ??= new Map();
  ctx.pathsReadAfterFailedMutation ??= new Set();
  ctx.inFlightMutationPaths ??= new Set();
  ctx.mutationEpoch ??= 0;
  const key = toolCallKey(toolName, input);
  const pathForInput = inputPath(input);
  if (isMutatingTool(toolName) && pathForInput && ctx.inFlightMutationPaths.has(pathForInput)) {
    return {
      ok: true,
      duplicateSkipped: true,
      toolName,
      reason: `Skipped concurrent mutation for ${pathForInput}. Read the file again, then make one editFile call with all non-overlapping replacements or one replaceLines call based on the latest line numbers.`,
    };
  }
  if (isMutatingTool(toolName) && pathForInput && ctx.failedMutationPaths.has(pathForInput) && !ctx.pathsReadAfterFailedMutation.has(pathForInput)) {
    const reason = ctx.failedMutationReasons.get(pathForInput);
    throw new HazeToolError(`Read ${pathForInput} before attempting another edit after the previous edit failure${reason ? ` (${reason})` : ''}.`, reason ?? 'io_error', {recoveryTool: 'readFile', recoveryInput: {path: pathForInput}});
  }
  const completedAt = ctx.completedToolCalls.get(key);
  const readAfterFailedMutation = toolName === 'readFile' && pathForInput && ctx.failedMutationPaths.has(pathForInput) && !ctx.pathsReadAfterFailedMutation.has(pathForInput);
  if ((isReadOnlyFileTool(toolName) || toolName === 'bash') && completedAt === ctx.mutationEpoch && !readAfterFailedMutation) {
    return {
      ok: true,
      duplicateSkipped: true,
      toolName,
      reason: toolName === 'bash'
        ? 'Skipped duplicate bash command; no files changed since the previous run.'
        : 'Skipped duplicate read-only tool call with identical input; no files changed since the previous call.',
    };
  }
  if (ctx.inFlightToolCalls.has(key)) {
    return {
      ok: true,
      duplicateSkipped: true,
      toolName,
      reason: 'Skipped duplicate in-flight tool call with identical input.',
    };
  }

  if (isMutatingTool(toolName) && pathForInput) ctx.inFlightMutationPaths.add(pathForInput);
  const promise = execute();
  ctx.inFlightToolCalls.set(key, promise);
  try {
    const result = await promise;
    if (isStructuredFailure(result)) {
      if (isMutatingTool(toolName) && pathForInput) {
        ctx.failedMutationPaths.add(pathForInput);
        const reasonCode = typeof result === 'object' && result != null && 'reasonCode' in result ? result.reasonCode as ToolFailureReasonCode | undefined : undefined;
        ctx.failedMutationReasons.set(pathForInput, reasonCode);
        ctx.pathsReadAfterFailedMutation.delete(pathForInput);
      }
      return result;
    }
    if (toolName === 'readFile' && pathForInput) ctx.pathsReadAfterFailedMutation.add(pathForInput);
    if (isMutatingTool(toolName)) {
      ctx.mutationEpoch += 1;
      if (pathForInput) {
        ctx.failedMutationPaths.delete(pathForInput);
        ctx.failedMutationReasons.delete(pathForInput);
        ctx.pathsReadAfterFailedMutation.delete(pathForInput);
      }
    }
    ctx.completedToolCalls.set(key, ctx.mutationEpoch);
    return result;
  } catch (error) {
    if (isMutatingTool(toolName) && pathForInput) {
      ctx.failedMutationPaths.add(pathForInput);
      ctx.failedMutationReasons.set(pathForInput, error instanceof HazeToolError ? error.reasonCode : undefined);
      ctx.pathsReadAfterFailedMutation.delete(pathForInput);
    }
    throw error;
  } finally {
    ctx.inFlightToolCalls.delete(key);
    if (isMutatingTool(toolName) && pathForInput) ctx.inFlightMutationPaths?.delete(pathForInput);
  }
}

export const hazeTools = {
  listFiles: tool({
    description: 'List files and directories in the current workspace. Prefer this over bash ls/find for discovering project structure.',
    inputSchema: z.object({
      path: z.string().default('.').describe('Directory path relative to the current workspace'),
      recursive: z.boolean().default(false).describe('Whether to list files recursively'),
      maxEntries: z.number().int().positive().max(500).default(100).describe('Maximum number of entries to return'),
      cursor: z.string().optional().describe('Pagination cursor from a previous listFiles result. Continue after that entry.'),
      includeIgnored: z.boolean().default(false).describe('Include files ignored by .gitignore. Use only when explicitly needed.'),
    }),
    execute: async ({path: dirPath, recursive, maxEntries, cursor, includeIgnored}, context) => runDedupedTool('listFiles', {path: dirPath, recursive, maxEntries, cursor, includeIgnored}, context, async () => {
      try {
        const absolutePath = resolveWorkspacePath(dirPath);
        await assertNotIgnored(absolutePath, dirPath, includeIgnored);
        const entries: Array<{path: string; type: 'file' | 'directory'; size?: number}> = [];
        let ignoredSkipped = 0;

        const walked = await walkDir(absolutePath, {recursive, maxEntries: maxEntries + 1, cursor, filter: async entry => {
          if (!includeIgnored && await isGitIgnored(entry.absolutePath)) { ignoredSkipped++; return false; }
          return true;
        }});
        const page = walked.slice(0, maxEntries);
        const hasMore = walked.length > maxEntries;

        for (const entry of page) {
          if (entry.isDirectory) {
            entries.push({path: entry.path, type: 'directory'});
          } else if (entry.isFile) {
            const stat = await fs.stat(entry.absolutePath);
            entries.push({path: entry.path, type: 'file', size: stat.size});
          }
        }

        return {path: dirPath, recursive, includeIgnored, cursor, nextCursor: hasMore ? page.at(-1)?.path : undefined, ignoredSkipped, entries, truncated: hasMore};
      } catch (error) {
        return structuredToolFailure('listFiles', error, 'Check that the directory exists and is not ignored, or retry with a narrower path.', dirPath);
      }
    }),
  }),

  readFile: tool({
    description: 'Read a UTF-8 text file from the current workspace. Supports optional 1-based line offset and line limit.',
    inputSchema: z.object({
      path: z.string().describe('File path relative to the current workspace'),
      offset: z.number().int().positive().optional().describe('1-based line number to start reading from'),
      limit: z.number().int().positive().max(2000).optional().describe('Maximum number of lines to return'),
      allowIgnored: z.boolean().default(false).describe('Read the file even if it is ignored by .gitignore. Use only when explicitly needed.'),
    }),
    execute: async ({path: filePath, offset, limit, allowIgnored}, context) => runDedupedTool('readFile', {path: filePath, offset, limit, allowIgnored}, context, async () => {
      try {
        const absolutePath = resolveWorkspacePath(filePath);
        await assertNotIgnored(absolutePath, filePath, allowIgnored);
        const content = await fs.readFile(absolutePath, 'utf8');
        const lines = content.split(/\r?\n/);
        const start = offset == null ? 0 : offset - 1;
        const end = limit == null ? lines.length : start + limit;
        const selectedLines = lines.slice(start, end);
        const selected = selectedLines.join('\n');
        return {
          path: filePath,
          startLine: start + 1,
          endLine: Math.min(end, lines.length),
          totalLines: lines.length,
          lineNumberedText: numberLines(selectedLines, start + 1),
          ...truncate(selected),
        };
      } catch (error) {
        return structuredToolFailure('readFile', error, 'Check the path with listFiles, or set allowIgnored=true only if the user explicitly asked to inspect an ignored file.', filePath);
      }
    }),
  }),

  grep: tool({
    description: 'Search file contents with a regex pattern using ripgrep. Use this to find symbol definitions, usages, string literals, import paths, and code patterns across the workspace. Much faster and more targeted than reading files one by one with readFile. Respects .gitignore by default.',
    inputSchema: z.object({
      pattern: z.string().min(1).describe('Regex pattern to search for (PCRE-compatible). Examples: "function handleClick", "import.*from.*react", "class UserService", "TODO|FIXME"'),
      path: z.string().default('.').describe('Directory or file path to search in, relative to the workspace. Narrow this to focus results.'),
      glob: z.string().optional().describe('File glob filter. Examples: "*.ts", "*.{js,jsx}", "src/**/*.py". Narrows search to matching files.'),
      contextLines: z.number().int().nonnegative().max(5).default(2).describe('Number of context lines before and after each match (0-5). Use 0 for compact output, 2-3 for understanding surrounding code.'),
      maxMatches: z.number().int().positive().max(200).default(50).describe('Maximum number of matches to return. Increase for broad searches, decrease for focused lookups.'),
      caseInsensitive: z.boolean().default(false).describe('Case-insensitive matching. Useful for symbol names that may vary in casing.'),
    }),
    execute: async ({pattern, path: searchPath, glob, contextLines, maxMatches, caseInsensitive}, context) => runDedupedTool('grep', {pattern, path: searchPath, glob, contextLines, maxMatches, caseInsensitive}, context, async () => {
      try {
        const absolutePath = resolveWorkspacePath(searchPath);
        const args = [
          '--no-heading', '--line-number', '--color=never',
          '--max-count', String(maxMatches),
          '--context', String(contextLines),
        ];
        if (caseInsensitive) args.push('--ignore-case');
        if (glob) args.push('--glob', glob);
        args.push('--', pattern, absolutePath);

        let stdout = '';
        try {
          const result = await execFile(rgPath, args, {cwd: workspaceRoot(), timeout: 30_000});
          stdout = result.stdout;
        } catch (error) {
          const code = typeof error === 'object' && error != null && 'code' in error ? (error as {code?: unknown}).code : undefined;
          if (code === 1) {
            stdout = '';
          } else {
            throw error;
          }
        }

        if (!stdout) {
          return {pattern, path: searchPath, glob: glob ?? null, caseInsensitive, matches: [], totalMatches: 0, truncated: false};
        }

        const {text: output, truncated} = truncate(stdout);
        const lines = output.split('\n').filter(Boolean);
        const matches: Array<{file: string; line: number; content: string; isContext: boolean}> = [];

        for (const line of lines) {
          const match = line.match(/^(\S+?):(\d+)[-:](.*)$/);
          if (!match) continue;
          const [, file, lineStr, content] = match;
          if (file && lineStr && content !== undefined) {
            const isContext = line.includes('-');
            const relativePath = path.relative(workspaceRoot(), file);
            matches.push({file: relativePath, line: Number(lineStr), content, isContext});
          }
        }

        return {pattern, path: searchPath, glob: glob ?? null, caseInsensitive, matches, totalMatches: matches.filter(m => !m.isContext).length, truncated};
      } catch (error) {
        return structuredToolFailure('grep', error, 'Check that the search path exists and the pattern is valid regex. Try a narrower path or simpler pattern.', searchPath);
      }
    }),
  }),

  replaceLines: tool({
    description: 'Replace a 1-based inclusive line range in an existing UTF-8 text file. Prefer this after reading a file when exact editFile replacements are ambiguous or fail. If endLine is slightly beyond EOF, it is clamped to the current last line.',
    inputSchema: z.object({
      path: z.string().describe('File path relative to the current workspace'),
      startLine: z.number().int().positive().describe('First 1-based line number to replace'),
      endLine: z.number().int().nonnegative().describe('Last 1-based line number to replace, inclusive. To append at EOF, use startLine=totalLines+1 and endLine=totalLines.'),
      content: z.string().describe('Replacement content for the line range'),
      allowIgnored: z.boolean().default(false).describe('Edit the file even if it is ignored by .gitignore. Use only when explicitly needed.'),
    }),
    execute: async ({path: filePath, startLine, endLine, content, allowIgnored}, context) => runDedupedTool('replaceLines', {path: filePath, startLine, endLine, content, allowIgnored}, context, async () => {
      try {
        const absolutePath = resolveWorkspacePath(filePath);
        await assertNotIgnored(absolutePath, filePath, allowIgnored);
        const original = await fs.readFile(absolutePath, 'utf8');
        const hasTrailingNewline = original.endsWith('\n');
        const lines = original.split(/\r?\n/);
        if (hasTrailingNewline) lines.pop();
        const isAppend = startLine === lines.length + 1 && endLine === lines.length;
        if (!isAppend && endLine < startLine) throw new HazeToolError('endLine must be greater than or equal to startLine, except when appending at EOF with startLine=totalLines+1 and endLine=totalLines', 'invalid_line_range', {recoveryTool: 'readFile', recoveryInput: {path: filePath}});
        if (startLine > lines.length + 1) throw new HazeToolError(`startLine ${startLine} is beyond end of file (${lines.length} lines)`, 'invalid_line_range', {recoveryTool: 'readFile', recoveryInput: {path: filePath}});
        const effectiveEndLine = !isAppend && endLine > lines.length ? lines.length : endLine;
        const replacementLines = content.length === 0 ? [] : content.split(/\r?\n/);
        const removedText = isAppend ? '' : lines.slice(startLine - 1, effectiveEndLine).join('\n');
        const beforeContext = startLine > 1 ? {oldLine: startLine - 1, newLine: startLine - 1, text: lines[startLine - 2] ?? ''} : undefined;
        const afterContext = !isAppend && effectiveEndLine < lines.length
          ? {oldLine: effectiveEndLine + 1, newLine: startLine + replacementLines.length, text: lines[effectiveEndLine] ?? ''}
          : undefined;
        if (isAppend) {
          lines.push(...replacementLines);
        } else {
          lines.splice(startLine - 1, effectiveEndLine - startLine + 1, ...replacementLines);
        }
        const updated = lines.join('\n') + (hasTrailingNewline ? '\n' : '');
        const {diff, addedLines, removedLines} = replacementDiff(removedText, content, startLine, startLine, {before: beforeContext, after: afterContext});
        const diffLineCount = diff.length;
        await fs.writeFile(absolutePath, updated, 'utf8');
        return {ok: true, path: filePath, startLine, endLine: effectiveEndLine, requestedEndLine: endLine, endLineClamped: effectiveEndLine !== endLine, replacementLines: replacementLines.length, appended: isAppend, addedLines, removedLines, diffLineCount, diff: diffLineCount <= INLINE_DIFF_LINE_LIMIT ? diff : undefined};
      } catch (error) {
        return structuredToolFailure('replaceLines', error, 'Read the file again for current line numbers, then retry replaceLines with a valid range.', filePath);
      }
    }),
  }),

  writeFile: tool({
    description: 'Create a UTF-8 text file in the current workspace. For existing files, prefer editFile/replaceLines; set overwriteExisting=true only for an intentional complete rewrite.',
    inputSchema: z.object({
      path: z.string().describe('File path relative to the current workspace'),
      content: z.string().describe('Complete file contents to write'),
      overwriteExisting: z.boolean().default(false).describe('Required to overwrite an existing file. Prefer editFile or replaceLines for existing files unless a complete rewrite is intentional.'),
      allowIgnored: z.boolean().default(false).describe('Write the file even if it is ignored by .gitignore. Use only when explicitly needed.'),
    }),
    execute: async ({path: filePath, content, overwriteExisting, allowIgnored}, context) => runDedupedTool('writeFile', {path: filePath, content, overwriteExisting, allowIgnored}, context, async () => {
      try {
        const absolutePath = resolveWorkspacePath(filePath);
        await assertNotIgnored(absolutePath, filePath, allowIgnored);
        try {
          await fs.access(absolutePath);
          if (!overwriteExisting) {
            throw new HazeToolError(`Refusing to overwrite existing file: ${filePath}. Use editFile/replaceLines for targeted edits, or set overwriteExisting=true for an intentional complete rewrite.`, 'existing_file_requires_overwrite', {recoveryTool: 'readFile', recoveryInput: {path: filePath}});
          }
        } catch (error) {
          const code = typeof error === 'object' && error != null && 'code' in error ? (error as {code?: unknown}).code : undefined;
          if (code !== 'ENOENT') throw error;
        }
        await fs.mkdir(path.dirname(absolutePath), {recursive: true});
        await fs.writeFile(absolutePath, content, 'utf8');
        return {ok: true, path: filePath, bytes: Buffer.byteLength(content, 'utf8'), overwritten: overwriteExisting};
      } catch (error) {
        return structuredToolFailure('writeFile', error, 'Use editFile/replaceLines for existing files, set overwriteExisting=true only for an intentional rewrite, or check the path/ignored-file setting.', filePath);
      }
    }),
  }),

  editFile: tool({
    description: 'Edit a text file using unique replacements. Each oldText should match the current file; line-number prefixes from readFile output and trailing-whitespace-only differences are tolerated when the match is still unique. Put multiple edits to the same file in one call. If this fails because text is missing or not unique, read the file again and use replaceLines.',
    inputSchema: z.object({
      path: z.string().describe('File path relative to the current workspace'),
      edits: z.array(z.object({
        oldText: z.string().min(1).describe('Exact text to replace; must appear exactly once'),
        newText: z.string().describe('Replacement text'),
      })).min(1).describe('One or more non-overlapping exact replacements'),
      allowIgnored: z.boolean().default(false).describe('Edit the file even if it is ignored by .gitignore. Use only when explicitly needed.'),
    }),
    execute: async ({path: filePath, edits, allowIgnored}, context) => runDedupedTool('editFile', {path: filePath, edits, allowIgnored}, context, async () => {
      try {
        const absolutePath = resolveWorkspacePath(filePath);
        await assertNotIgnored(absolutePath, filePath, allowIgnored);
        const original = await fs.readFile(absolutePath, 'utf8');
        const ranges = edits.map((edit, index) => {
          const match = findEditRange(original, edit.oldText);
          if (match.kind === 'missing') throw new HazeToolError(`edit ${index}: oldText was not found. Read the file again and use the exact current text, or use replaceLines with the latest line numbers.`, 'old_text_missing', {recoveryTool: 'readFile', recoveryInput: {path: filePath}});
          if (match.kind === 'multiple') throw new HazeToolError(`edit ${index}: oldText is not unique`, 'old_text_not_unique', {recoveryTool: 'readFile', recoveryInput: {path: filePath}});
          return {index, start: match.start, end: match.end, edit, approximate: match.approximate};
        }).sort((a, b) => a.start - b.start);

        for (let i = 1; i < ranges.length; i++) {
          if (ranges[i]!.start < ranges[i - 1]!.end) {
            throw new HazeToolError(`edits ${ranges[i - 1]!.index} and ${ranges[i]!.index} overlap`, 'overlapping_edits', {recoveryTool: 'readFile', recoveryInput: {path: filePath}});
          }
        }

        let updated = original;
        for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
          updated = updated.slice(0, range.start) + range.edit.newText + updated.slice(range.end);
        }
        const originalLines = splitDiffLines(original);
        let lineDelta = 0;
        let addedLines = 0;
        let removedLines = 0;
        const diff: ToolDiffLine[] = [];
        for (const range of ranges) {
          const oldStartLine = lineNumberAtOffset(original, range.start);
          const newStartLine = oldStartLine + lineDelta;
          const oldLineCount = splitDiffLines(range.edit.oldText).length;
          const newLineCount = splitDiffLines(range.edit.newText).length;
          const beforeContext = oldStartLine > 1 ? {oldLine: oldStartLine - 1, newLine: newStartLine - 1, text: originalLines[oldStartLine - 2] ?? ''} : undefined;
          const afterOldLine = oldStartLine + oldLineCount;
          const afterContext = afterOldLine <= originalLines.length
            ? {oldLine: afterOldLine, newLine: newStartLine + newLineCount, text: originalLines[afterOldLine - 1] ?? ''}
            : undefined;
          const rangeDiff = replacementDiff(range.edit.oldText, range.edit.newText, oldStartLine, newStartLine, {before: beforeContext, after: afterContext});
          diff.push(...rangeDiff.diff);
          addedLines += rangeDiff.addedLines;
          removedLines += rangeDiff.removedLines;
          lineDelta += rangeDiff.addedLines - rangeDiff.removedLines;
        }
        const diffLineCount = diff.length;
        await fs.writeFile(absolutePath, updated, 'utf8');
        return {ok: true, path: filePath, edits: edits.length, approximateMatches: ranges.filter(range => range.approximate).length, addedLines, removedLines, diffLineCount, diff: diffLineCount <= INLINE_DIFF_LINE_LIMIT ? diff : undefined};
      } catch (error) {
        return structuredToolFailure('editFile', error, 'Read the file again, then retry with exact current text or use replaceLines with the latest line numbers.', filePath);
      }
    }),
  }),

  bash: tool({
    description: 'Run a bash command in the current workspace. Use for tests, builds, validation, and inspection. Do not use bash to edit files; use file tools instead unless the user explicitly requested a shell mutation.',
    inputSchema: z.object({
      command: z.string().min(1).describe('Command to execute with bash -lc'),
      timeoutSeconds: z.number().int().positive().max(600).optional().describe('Timeout in seconds; defaults to 60'),
      allowMutation: z.boolean().default(false).describe('Allow non-destructive professional workflow commands that mutate local state (chmod, redirects, tee, sed -i, installs, git add/commit, scripts). Set true when the user requested the operation or bash is materially more efficient. Destructive commands still require explicit confirmation.'),
    }),
    execute: async ({command, timeoutSeconds, allowMutation}, context) => runDedupedTool('bash', {command, timeoutSeconds, allowMutation}, context, async () => {
      const cwd = workspaceRoot();
      const classification = classifyBashCommand(command);
      if (classification.riskLevel === 'destructive') {
        return structuredToolFailure('bash', 'Command requires explicit user confirmation before execution.', 'Ask the user to confirm this destructive command, or choose a safer alternative.', undefined, {reasonCode: 'destructive_command_requires_confirmation', needsConfirmation: true, recoveryInput: {command, cwd, classification}});
      }
      if (classification.requiresConfirmation && !allowMutation) {
        return structuredToolFailure('bash', 'Command requires confirmation or allowMutation=true before execution.', 'Ask the user to confirm this command, or use file tools for file edits.', undefined, {reasonCode: 'mutating_command_requires_confirmation', needsConfirmation: true, recoveryInput: {command, cwd, classification}});
      }
      const timeoutMs = (timeoutSeconds ?? 60) * 1000;
      const startedAt = Date.now();
      return await new Promise(resolve => {
        const child = spawn('bash', ['-lc', command], {cwd, stdio: ['ignore', 'pipe', 'pipe']});
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        const timer = setTimeout(() => {
          if (!settled) {
            timedOut = true;
            child.kill('SIGTERM');
          }
        }, timeoutMs);
        const abort = () => child.kill('SIGTERM');
        context.abortSignal?.addEventListener('abort', abort, {once: true});
        child.stdout.on('data', data => stdout += data.toString());
        child.stderr.on('data', data => stderr += data.toString());
        child.on('close', code => {
          settled = true;
          clearTimeout(timer);
          context.abortSignal?.removeEventListener('abort', abort);
          const truncatedStdout = truncate(stdout);
          const truncatedStderr = truncate(stderr);
          const validationSummary = isValidationClassification(classification)
            ? parseValidationOutput({command, code, stdout, stderr, timedOut, stdoutTruncated: truncatedStdout.truncated, stderrTruncated: truncatedStderr.truncated, classification})
            : undefined;
          resolve({
            ok: code === 0 && !timedOut,
            code,
            command,
            cwd,
            classification,
            durationMs: Date.now() - startedAt,
            timedOut,
            stdout: truncatedStdout,
            stderr: truncatedStderr,
            validationSummary,
          });
        });
        child.on('error', error => {
          settled = true;
          clearTimeout(timer);
          context.abortSignal?.removeEventListener('abort', abort);
          resolve({ok: false, command, cwd, classification, durationMs: Date.now() - startedAt, error: error.message});
        });
      });
    }),
  }),
};

export type HazeTools = typeof hazeTools;
