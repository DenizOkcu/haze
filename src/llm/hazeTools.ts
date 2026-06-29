import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tool} from 'ai';
import {rgPath} from '@vscode/ripgrep';
import {z} from 'zod';
import {walkDir} from '../utils/fs.js';
import {writeTasksTool} from './tools/taskTool.js';
import {readToolOutputTool} from './tools/storedOutputTool.js';
import {workspaceRoot} from '../utils/path.js';

import type {ToolDiffLine} from './toolResultTypes.js';
import {storeToolOutput} from '../core/agent/toolOutputStore.js';
import {reductionMetrics} from '../core/toolOutput/reduction.js';
import {HazeToolError, structuredToolFailure} from './tools/failures.js';
import {compactGrepMatches, renderGrepMatches} from './tools/outputCap.js';
import {parseRipgrepJsonStream} from './tools/grepParse.js';
import {findEditRange, splitDiffLines, lineNumberAtOffset, replacementDiff} from './tools/editMatch.js';
import {runDedupedTool, discoverScopedContext, withScopedContext} from './tools/toolContext.js';
import {prepareWorkspaceExisting, prepareWorkspaceMutation, prepareWorkspaceRead, prepareWorkspaceWritePath} from './tools/workspaceFile.js';
import {fetchTool} from './tools/fetchTool.js';
import {bashTool} from './tools/bashTool.js';
import {DEFAULT_READ_LINES, INLINE_DIFF_LINE_LIMIT, isGitIgnored, MAX_OUTPUT_CHARS, sourceOutlineEntries} from './tools/fileToolShared.js';
import {searchMemory, storeMemory} from '../core/memory/memoryStore.js';

const execFile = promisify(execFileCallback);

export const hazeTools = {
  listFiles: tool({
    description: 'List workspace files/directories with pagination. Prefer this to bash for discovery.',
    inputSchema: z.object({
      path: z.string().default('.').describe('Directory path relative to the current workspace'),
      recursive: z.boolean().default(false).describe('Whether to list files recursively'),
      maxEntries: z.number().int().positive().max(500).default(100).describe('Maximum number of entries to return'),
      cursor: z.string().optional().describe('Pagination cursor from a previous listFiles result. Continue after that entry.'),
      includeIgnored: z.boolean().default(false).describe('Include .gitignored paths only when needed'),
      includeSizes: z.boolean().default(false).describe('Include file byte sizes only when needed; omitted by default for compact output'),
    }),
    execute: async ({path: dirPath, recursive, maxEntries, cursor, includeIgnored, includeSizes}, context) => runDedupedTool('listFiles', {path: dirPath, recursive, maxEntries, cursor, includeIgnored, includeSizes}, context, async () => {
      try {
        const absolutePath = await prepareWorkspaceRead(dirPath, includeIgnored);
        const entries: string[] = [];
        let ignoredSkipped = 0;

        const walked = await walkDir(absolutePath, {recursive, maxEntries: maxEntries + 1, cursor, filter: async entry => {
          if (!includeIgnored && await isGitIgnored(entry.absolutePath)) { ignoredSkipped++; return false; }
          return true;
        }});
        const page = walked.slice(0, maxEntries);
        const hasMore = walked.length > maxEntries;

        for (const entry of page) {
          if (entry.isDirectory) {
            entries.push(`${entry.path}/`);
          } else if (entry.isFile) {
            if (includeSizes) {
              const stat = await fs.stat(entry.absolutePath);
              entries.push(`${entry.path} (${stat.size} bytes)`);
            } else {
              entries.push(entry.path);
            }
          }
        }

        const scopedContext = await discoverScopedContext(dirPath, context);
        return withScopedContext({path: dirPath, recursive, includeIgnored, includeSizes, cursor, nextCursor: hasMore ? page.at(-1)?.path : undefined, ignoredSkipped, entryFormat: includeSizes ? 'directories end with /; files may include byte size in parentheses' : 'directories end with /', entries, truncated: hasMore}, scopedContext);
      } catch (error) {
        return structuredToolFailure('listFiles', error, 'Check that the directory exists and is not ignored, or retry with a narrower path.', dirPath);
      }
    }),
  }),

  readFile: tool({
    description: 'Read numbered lines from a UTF-8 workspace file. Defaults to exact mode; outline mode is for discovery only and must be followed by exact reads before editing.',
    inputSchema: z.object({
      path: z.string().describe('File path relative to the current workspace'),
      offset: z.number().int().positive().optional().describe('1-based line number to start reading from'),
      limit: z.number().int().positive().max(2000).optional().describe('Maximum lines to return; defaults to 300'),
      mode: z.enum(['exact', 'outline']).default('exact').describe('exact returns source lines; outline returns imports/includes and top-level declarations for discovery only'),
      allowIgnored: z.boolean().default(false).describe('Read a .gitignored file only when needed'),
    }),
    execute: async ({path: filePath, offset, limit, mode, allowIgnored}, context) => runDedupedTool('readFile', {path: filePath, offset, limit, mode, allowIgnored}, context, async () => {
      try {
        const absolutePath = await prepareWorkspaceRead(filePath, allowIgnored);
        const content = await fs.readFile(absolutePath, 'utf8');
        const lines = content.split(/\r?\n/);
        const start = offset == null ? 0 : offset - 1;
        const requestedEnd = Math.min(lines.length, start + (limit ?? DEFAULT_READ_LINES));
        const selectedLines = lines.slice(start, requestedEnd);
        const outlineEntries = mode === 'outline' ? sourceOutlineEntries(selectedLines, start + 1) : undefined;
        const displayLines = outlineEntries?.map(entry => ({lineNumber: entry.lineNumber, text: entry.text}))
          ?? selectedLines.map((line, index) => ({lineNumber: start + index + 1, text: line}));
        const numberedLines: string[] = [];
        let includedLines = 0;
        let lineTruncated = false;
        let outputChars = 0;
        for (const entry of displayLines) {
          const prefix = `${String(entry.lineNumber).padStart(4, ' ')} | `;
          const separatorChars = numberedLines.length > 0 ? 1 : 0;
          const remaining = MAX_OUTPUT_CHARS - outputChars - separatorChars;
          if (remaining <= prefix.length) break;
          if (prefix.length + entry.text.length > remaining) {
            const line = `${prefix}${entry.text.slice(0, Math.max(0, remaining - prefix.length - 26))}[line content truncated]`;
            numberedLines.push(line);
            outputChars += separatorChars + line.length;
            includedLines += 1;
            lineTruncated = true;
            break;
          }
          const line = `${prefix}${entry.text}`;
          numberedLines.push(line);
          outputChars += separatorChars + line.length;
          includedLines += 1;
        }
        const endLine = mode === 'outline'
          ? displayLines[Math.max(0, includedLines - 1)]?.lineNumber ?? start + 1
          : start + includedLines;
        const hasMore = mode === 'outline'
          ? requestedEnd < lines.length
          : endLine < lines.length;
        const scopedContext = await discoverScopedContext(filePath, context);
        return withScopedContext({
          path: filePath,
          mode,
          startLine: start + 1,
          endLine,
          totalLines: lines.length,
          content: numberedLines.join('\n'),
          nextOffset: hasMore ? requestedEnd + 1 : undefined,
          truncated: hasMore || lineTruncated,
          lineTruncated,
          ...(mode === 'outline' ? {outline: true, outlineEntries: includedLines, warning: 'Outline mode is lossy discovery output. Use exact readFile around relevant lines before editing.'} : {}),
        }, scopedContext);
      } catch (error) {
        return structuredToolFailure('readFile', error, 'Check the path with listFiles, or set allowIgnored=true only if the user explicitly asked to inspect an ignored file.', filePath);
      }
    }),
  }),

  grep: tool({
    description: 'Regex search workspace files with structured, globally capped results. Prefer this to reading files one by one.',
    inputSchema: z.object({
      pattern: z.string().min(1).describe('Regex pattern'),
      path: z.string().default('.').describe('Workspace-relative file or directory'),
      glob: z.string().optional().describe('Optional file glob, e.g. "*.ts"'),
      contextLines: z.number().int().nonnegative().max(5).default(2).describe('Context lines before/after each match'),
      maxMatches: z.number().int().positive().max(200).default(50).describe('Global match limit'),
      caseInsensitive: z.boolean().default(false).describe('Ignore case'),
    }),
    execute: async ({pattern, path: searchPath, glob, contextLines, maxMatches, caseInsensitive}, context) => runDedupedTool('grep', {pattern, path: searchPath, glob, contextLines, maxMatches, caseInsensitive}, context, async () => {
      try {
        const absolutePath = await prepareWorkspaceExisting(searchPath);
        const args = [
          '--json', '--color=never',
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

        const scopedContext = await discoverScopedContext(searchPath, context);
        if (!stdout) {
          return withScopedContext({pattern, path: searchPath, glob: glob ?? null, caseInsensitive, matches: [], totalMatches: 0, truncated: false}, scopedContext);
        }

        const parsed = parseRipgrepJsonStream(stdout, maxMatches, contextLines, absolute => path.relative(workspaceRoot(), absolute));
        const matches = parsed.matches;
        const totalMatches = parsed.totalMatches;
        const returnedMatches = parsed.returnedMatches;
        const omittedMatches = parsed.omittedMatches;

        const compacted = compactGrepMatches(matches);
        const outputTruncated = compacted.outputTruncated;
        const rawRenderedMatches = renderGrepMatches(matches);
        const returnedRenderedMatches = renderGrepMatches(compacted.matches);
        const grepMetrics = reductionMetrics(rawRenderedMatches, returnedRenderedMatches);
        const fullOutputHandle = outputTruncated ? storeToolOutput(rawRenderedMatches) : undefined;
        return withScopedContext({
          pattern,
          path: searchPath,
          glob: glob ?? null,
          caseInsensitive,
          matches: compacted.matches,
          totalMatches,
          returnedMatches,
          omittedMatches,
          omittedResultLines: compacted.omittedResultLines,
          lineTruncated: compacted.lineTruncated,
          truncated: omittedMatches > 0 || outputTruncated,
          reducerName: 'grep-structured',
          contentKind: 'search',
          lossy: omittedMatches > 0 || outputTruncated,
          parseTier: 'full',
          ...grepMetrics,
          ...(fullOutputHandle ? {handle: fullOutputHandle, rawHandle: fullOutputHandle, omittedChars: Math.max(0, rawRenderedMatches.length - returnedRenderedMatches.length)} : {omittedChars: 0}),
          suggestion: omittedMatches > 0 || outputTruncated ? 'Narrow the path, glob, or pattern to inspect omitted results, or use readToolOutput with the handle when present.' : undefined,
        }, scopedContext);
      } catch (error) {
        return structuredToolFailure('grep', error, 'Check that the search path exists and the pattern is valid regex. Try a narrower path or simpler pattern.', searchPath);
      }
    }),
  }),

  replaceLines: tool({
    description: 'Replace a 1-based inclusive line range. Use after readFile when exact editFile text is ambiguous or stale.',
    inputSchema: z.object({
      path: z.string().describe('File path relative to the current workspace'),
      startLine: z.number().int().positive().describe('First 1-based line number to replace'),
      endLine: z.number().int().nonnegative().describe('Last 1-based line number to replace, inclusive. To append at EOF, use startLine=totalLines+1 and endLine=totalLines.'),
      content: z.string().describe('Replacement content for the line range'),
      allowIgnored: z.boolean().default(false).describe('Edit the file even if it is ignored by .gitignore. Use only when explicitly needed.'),
    }),
    execute: async ({path: filePath, startLine, endLine, content, allowIgnored}, context) => runDedupedTool('replaceLines', {path: filePath, startLine, endLine, content, allowIgnored}, context, async () => {
      try {
        const {absolutePath, scopedStop} = await prepareWorkspaceMutation('replaceLines', filePath, allowIgnored, context);
        if (scopedStop) return scopedStop;
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
    description: 'Create a UTF-8 file. Existing files require explicit full-rewrite approval.',
    inputSchema: z.object({
      path: z.string().describe('File path relative to the current workspace'),
      content: z.string().describe('Complete file contents to write'),
      overwriteExisting: z.boolean().default(false).describe('Approve intentional full rewrite of an existing file'),
      allowIgnored: z.boolean().default(false).describe('Write a .gitignored file only when needed'),
    }),
    execute: async ({path: filePath, content, overwriteExisting, allowIgnored}, context) => runDedupedTool('writeFile', {path: filePath, content, overwriteExisting, allowIgnored}, context, async () => {
      try {
        const {absolutePath, scopedStop, assertExistingInsideWorkspace, assertWritableInsideWorkspace} = await prepareWorkspaceWritePath('writeFile', filePath, allowIgnored, context);
        if (scopedStop) return scopedStop;
        try {
          await fs.access(absolutePath);
          await assertExistingInsideWorkspace();
          if (!overwriteExisting) {
            throw new HazeToolError(`Refusing to overwrite existing file: ${filePath}. Use editFile/replaceLines for targeted edits, or set overwriteExisting=true for an intentional complete rewrite.`, 'existing_file_requires_overwrite', {recoveryTool: 'readFile', recoveryInput: {path: filePath}});
          }
        } catch (error) {
          const code = typeof error === 'object' && error != null && 'code' in error ? (error as {code?: unknown}).code : undefined;
          if (code !== 'ENOENT') throw error;
          await assertWritableInsideWorkspace();
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
    description: 'Apply unique text replacements. Batch same-file edits; reread and use replaceLines if matching fails.',
    inputSchema: z.object({
      path: z.string().describe('File path relative to the current workspace'),
      edits: z.array(z.object({
        oldText: z.string().min(1).describe('Exact text to replace; must appear exactly once'),
        newText: z.string().describe('Replacement text'),
      })).min(1).describe('One or more non-overlapping exact replacements'),
      allowIgnored: z.boolean().default(false).describe('Edit a .gitignored file only when needed'),
    }),
    execute: async ({path: filePath, edits, allowIgnored}, context) => runDedupedTool('editFile', {path: filePath, edits, allowIgnored}, context, async () => {
      try {
        const {absolutePath, scopedStop} = await prepareWorkspaceMutation('editFile', filePath, allowIgnored, context);
        if (scopedStop) return scopedStop;
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

  writeTasks: writeTasksTool,

  readToolOutput: readToolOutputTool,

  fetch: fetchTool,

  bash: bashTool,

  memory: tool({
    description: 'Persistent workspace memory. Store facts a future session would not derive from AGENTS.md or the codebase directly: user corrections, project conventions, and recurring architectural decisions. Search returns substring matches across keys, values, and tags.',
    inputSchema: z.discriminatedUnion('operation', [
      z.object({
        operation: z.literal('store'),
        key: z.string().min(1).describe('Short label for the memory entry'),
        value: z.string().min(1).describe('The fact, convention, or correction to remember'),
        tags: z.array(z.string()).optional().describe('Optional lowercase tags to improve searchability, e.g. ["convention", "testing"]'),
      }),
      z.object({
        operation: z.literal('search'),
        query: z.string().min(1).describe('Search query matched against key, value, and tags'),
      }),
    ]),
    execute: async input => {
      try {
        if (input.operation === 'store') {
          const entry = await storeMemory({key: input.key, value: input.value, tags: input.tags});
          return {ok: true, operation: 'store', entry};
        }
        const entries = await searchMemory(input.query);
        return {ok: true, operation: 'search', entries};
      } catch (error) {
        return structuredToolFailure('memory', error, 'Retry or use /memory to inspect workspace memory.', undefined);
      }
    },
  }),

};

export type HazeTools = typeof hazeTools;
