import fs from 'node:fs/promises';
import path from 'node:path';
import {tool} from 'ai';
import {rgPath} from '@vscode/ripgrep';
import {z} from 'zod';
import {walkDir, type WalkEntry} from '../utils/fs.js';
import {writeTasksTool} from './tools/taskTool.js';
import {readToolOutputTool} from './tools/storedOutputTool.js';
import {workspaceRoot} from '../utils/path.js';

import type {ToolDiffLine} from './toolResultTypes.js';
import {storeToolOutput} from '../core/agent/toolOutputStore.js';
import {reductionMetrics} from '../core/toolOutput/reduction.js';
import {HazeToolError, structuredToolFailure} from './tools/failures.js';
import {compactGrepMatches, renderGrepMatches} from './tools/outputCap.js';
import {parseRipgrepJsonStream} from './tools/grepParse.js';
import {boundedDiff, fileDiff, findEditRange, splitDiffLines, lineNumberAtOffset, renderToolDiff, replacementDiff} from './tools/editMatch.js';
import {runDedupedTool, discoverScopedContext, withScopedContext, hazeToolContextSchema} from './tools/toolContext.js';
import {prepareWorkspaceMutation, prepareWorkspaceRead, prepareWorkspaceWritePath} from './tools/workspaceFile.js';
import {fetchTool} from './tools/fetchTool.js';
import {shellTool} from './tools/shellTool.js';
import {processTool} from './tools/processTool.js';
import {DEFAULT_READ_LINES, INLINE_DIFF_LINE_LIMIT, MAX_OUTPUT_CHARS, sourceOutlineEntries} from './tools/fileToolShared.js';
import {createIgnoreClassifier} from './tools/gitIgnore.js';
import {runRipgrepBounded} from './tools/grepRunner.js';
import {secretSearchExcludeGlobs} from '../core/safety/secretPaths.js';
import {EXACT_MUTATION_BYTES} from '../core/limits.js';
import {WRITE_FILE_CHUNK_BYTES} from '../core/agent/budgets.js';
import {readUtf8LinesPage, readUtf8Prefix} from '../core/io/boundedRead.js';
import {assertReadableTextFile, readFailureRecovery} from './tools/readRecovery.js';

function mutationDiffFields(filePath: string, fullDiff: ToolDiffLine[]) {
  const preview = boundedDiff(fullDiff, INLINE_DIFF_LINE_LIMIT);
  const diffHandle = preview.truncated ? storeToolOutput(renderToolDiff(filePath, fullDiff)) : undefined;
  return {
    diffLineCount: fullDiff.length,
    diff: preview.diff,
    diffTruncated: preview.truncated,
    diffOmittedLines: preview.omittedLines,
    ...(diffHandle ? {diffHandle} : {}),
  };
}

export const hazeTools = {
  listFiles: tool({
    description: 'List workspace files/directories with pagination. Prefer this to shell for discovery.',
    contextSchema: hazeToolContextSchema,
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
        const absolutePath = await prepareWorkspaceRead(dirPath, includeIgnored, context);
        const entries: string[] = [];
        let ignoredSkipped = 0;

        // One persistent classifier owns the whole listing so rule files are
        // cached across directory frontiers. Walk entries include absolute paths,
        // allowing subtree listings to classify workspace-relative identities.
        const ignoreClassifier = includeIgnored ? undefined : createIgnoreClassifier(workspaceRoot());
        const ignoreBatch = ignoreClassifier ? (entries: WalkEntry[]) =>
          ignoreClassifier.classify(entries).then(ignored => {
            ignoredSkipped += ignored.size;
            return ignored;
          }) : undefined;

        const walked = await walkDir(absolutePath, {recursive, maxEntries: maxEntries + 1, cursor, ignoreBatch});
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
    contextSchema: hazeToolContextSchema,
    inputSchema: z.object({
      path: z.string().describe('File path relative to the current workspace'),
      offset: z.number().int().positive().optional().describe('1-based line number to start reading from'),
      limit: z.number().int().positive().max(2000).optional().describe('Maximum lines to return; defaults to 300'),
      mode: z.enum(['exact', 'outline']).default('exact').describe('exact returns source lines; outline returns imports/includes and top-level declarations for discovery only'),
      allowIgnored: z.boolean().default(false).describe('Read a .gitignored file only when needed'),
    }),
    execute: async ({path: filePath, offset, limit, mode, allowIgnored}, context) => runDedupedTool('readFile', {path: filePath, offset, limit, mode, allowIgnored}, context, async () => {
      try {
        const absolutePath = await prepareWorkspaceRead(filePath, allowIgnored, context);
        await assertReadableTextFile(absolutePath, filePath);
        const start = offset == null ? 0 : offset - 1;
        const pageLimit = limit ?? DEFAULT_READ_LINES;
        const page = await readUtf8LinesPage(absolutePath, start + 1, pageLimit);
        if (offset != null && offset > page.totalLines) {
          throw new HazeToolError(`offset ${offset} is beyond end of file (${page.totalLines} lines)`, 'invalid_line_range', {recoveryTool: 'readFile', recoveryInput: {path: filePath, offset: Math.max(1, page.totalLines)}});
        }
        const lines = page.lines;
        const totalLines = page.totalLines;
        const requestedEnd = Math.min(totalLines, start + pageLimit);
        const selectedLines = lines;
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
        const outlineDroppedEntries = mode === 'outline' ? displayLines.length - includedLines : 0;
        const hasMore = mode === 'outline'
          ? requestedEnd < totalLines || outlineDroppedEntries > 0
          : endLine < totalLines;
        // Outline pages resume after the last *included* entry: the output cap can
        // stop a page before requestedEnd, and jumping to requestedEnd + 1 would
        // silently skip the entries in between (CR-028).
        const nextOffset = hasMore
          ? (mode === 'outline' && includedLines > 0 ? endLine + 1 : requestedEnd + 1)
          : undefined;
        const scopedContext = await discoverScopedContext(filePath, context);
        return withScopedContext({
          path: filePath,
          mode,
          startLine: start + 1,
          endLine,
          totalLines,
          content: numberedLines.join('\n'),
          nextOffset,
          truncated: hasMore || lineTruncated,
          lineTruncated,
          ...(mode === 'outline' ? {outline: true, outlineEntries: includedLines, ...(outlineDroppedEntries > 0 ? {outlineDroppedEntries} : {}), warning: 'Outline mode is lossy discovery output. Use exact readFile around relevant lines before editing.'} : {}),
        }, scopedContext);
      } catch (error) {
        const recovery = await readFailureRecovery(filePath, error);
        return structuredToolFailure('readFile', error, recovery.suggestedNextStep, filePath, {reasonCode: recovery.reasonCode, suggestedPaths: recovery.suggestedPaths});
      }
    }),
  }),

  grep: tool({
    description: 'Regex search workspace files with structured, globally capped results. Prefer this to reading files one by one.',
    contextSchema: hazeToolContextSchema,
    inputSchema: z.object({
      pattern: z.string().min(1).describe('Regex pattern'),
      path: z.string().default('.').describe('Workspace-relative file or directory'),
      glob: z.string().optional().describe('Optional file glob, e.g. "*.ts"'),
      contextLines: z.number().int().nonnegative().max(5).default(2).describe('Context lines before/after each match'),
      maxMatches: z.number().int().positive().max(200).default(50).describe('Global match limit (enforced by the runner; ripgrep also applies it as a per-file cap)'),
      caseInsensitive: z.boolean().default(false).describe('Ignore case'),
      includeIgnored: z.boolean().default(false).describe('Search ignored paths only when explicitly needed'),
    }),
    execute: async ({pattern, path: searchPath, glob, contextLines, maxMatches, caseInsensitive, includeIgnored}, context) => runDedupedTool('grep', {pattern, path: searchPath, glob, contextLines, maxMatches, caseInsensitive, includeIgnored}, context, async () => {
      try {
        const absolutePath = await prepareWorkspaceRead(searchPath, includeIgnored, context);
        const args = [
          '--json', '--color=never',
          '--max-count', String(maxMatches),
          '--context', String(contextLines),
        ];
        if (caseInsensitive) args.push('--ignore-case');
        if (glob) args.push('--glob', glob);
        // Secret-file exclusions come after any model-supplied glob: later
        // ripgrep globs take precedence, and an explicit glob (which also
        // re-enables hidden-file search) must never re-include secrets.
        for (const secretGlob of secretSearchExcludeGlobs()) args.push('--glob', secretGlob);
        args.push('--', pattern, absolutePath);

        const result = await runRipgrepBounded({executable: rgPath, args, cwd: workspaceRoot(), maxMatches, signal: context.abortSignal});
        const stdout = result.stdout;
        if (result.aborted) throw new Error('ripgrep aborted');
        if (result.timedOut) throw new Error('ripgrep timed out');
        if (result.code !== 0 && result.code !== 1 && !result.capped) throw new Error(result.stderr || `ripgrep exited with code ${result.code}`);

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
          truncated: result.capped || omittedMatches > 0 || outputTruncated,
          matchCountIsLowerBound: result.capped,
          reducerName: 'grep-structured',
          contentKind: 'search',
          lossy: result.capped || omittedMatches > 0 || outputTruncated,
          parseTier: 'full',
          ...grepMetrics,
          ...(fullOutputHandle ? {handle: fullOutputHandle, rawHandle: fullOutputHandle, omittedChars: Math.max(0, rawRenderedMatches.length - returnedRenderedMatches.length)} : {omittedChars: 0}),
          suggestion: result.capped || omittedMatches > 0 || outputTruncated ? 'Narrow the path, glob, or pattern to inspect omitted results, or use readToolOutput with the handle when present.' : undefined,
        }, scopedContext);
      } catch (error) {
        return structuredToolFailure('grep', error, 'Check that the search path exists and the pattern is valid regex. Try a narrower path or simpler pattern.', searchPath);
      }
    }),
  }),

  replaceLines: tool({
    description: 'Replace a 1-based inclusive line range. Use after readFile when exact editFile text is ambiguous or stale.',
    contextSchema: hazeToolContextSchema,
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
        const file = await readUtf8Prefix(absolutePath, EXACT_MUTATION_BYTES);
        if (file.truncated) throw new HazeToolError(`File exceeds ${EXACT_MUTATION_BYTES} byte exact-mutation limit`, 'file_too_large');
        const original = file.content;
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
        const replacement = replacementDiff(removedText, content, startLine, startLine, {before: beforeContext, after: afterContext});
        const changed = updated !== original;
        await fs.writeFile(absolutePath, updated, 'utf8');
        return {
          ok: true,
          path: filePath,
          startLine,
          endLine: effectiveEndLine,
          requestedEndLine: endLine,
          endLineClamped: effectiveEndLine !== endLine,
          replacementLines: replacementLines.length,
          appended: isAppend,
          noChange: !changed,
          addedLines: changed ? replacement.addedLines : 0,
          removedLines: changed ? replacement.removedLines : 0,
          ...mutationDiffFields(filePath, changed ? replacement.diff : []),
        };
      } catch (error) {
        return structuredToolFailure('replaceLines', error, 'Read the file again for current line numbers, then retry replaceLines with a valid range.', filePath);
      }
    }),
  }),

  writeFile: tool({
    description: `Create, rewrite, or append a UTF-8 file in chunks of at most ${WRITE_FILE_CHUNK_BYTES} bytes. Existing files require explicit rewrite or append approval.`,
    contextSchema: hazeToolContextSchema,
    inputSchema: z.object({
      path: z.string().describe('File path relative to the current workspace'),
      // Size policy lives in execute (write_chunk_too_large with chunking
      // guidance), not in the schema: a Zod .max() would shadow that error
      // with a cryptic AI_TypeValidationError before execute can run.
      content: z.string().describe(`File content chunk, at most ${WRITE_FILE_CHUNK_BYTES} UTF-8 bytes`),
      overwriteExisting: z.boolean().default(false).describe('Approve replacing an existing file with the first chunk of an intentional full rewrite'),
      append: z.boolean().default(false).describe('Append this chunk to an existing file; use after creating or replacing the file with the first chunk'),
      allowIgnored: z.boolean().default(false).describe('Write a .gitignored file only when needed'),
    }),
    execute: async ({path: filePath, content, overwriteExisting, append, allowIgnored}, context) => runDedupedTool('writeFile', {path: filePath, content, overwriteExisting, append, allowIgnored}, context, async () => {
      try {
        const contentBytes = Buffer.byteLength(content, 'utf8');
        if (contentBytes > WRITE_FILE_CHUNK_BYTES) {
          throw new HazeToolError(`Content is ${contentBytes} UTF-8 bytes; writeFile accepts at most ${WRITE_FILE_CHUNK_BYTES} bytes per call. Write the first chunk normally, then use append=true for later chunks.`, 'write_chunk_too_large');
        }
        if (append && overwriteExisting) {
          throw new HazeToolError('append=true and overwriteExisting=true are mutually exclusive', 'conflicting_write_modes');
        }
        const {absolutePath, scopedStop, assertExistingInsideWorkspace, assertWritableInsideWorkspace} = await prepareWorkspaceWritePath('writeFile', filePath, allowIgnored, context);
        if (scopedStop) return scopedStop;
        let targetExisted = false;
        let previousContent = '';
        let previousContentTruncated = false;
        let previousContentOmittedBytes = 0;
        try {
          await fs.access(absolutePath);
          targetExisted = true;
          await assertExistingInsideWorkspace();
          if (!overwriteExisting && !append) {
            throw new HazeToolError(`Refusing to overwrite existing file: ${filePath}. Use editFile/replaceLines for targeted edits, set append=true for a later chunk, or set overwriteExisting=true for an intentional rewrite.`, 'existing_file_requires_overwrite', {recoveryTool: 'readFile', recoveryInput: {path: filePath}});
          }
          const previous = await readUtf8Prefix(absolutePath, EXACT_MUTATION_BYTES);
          previousContent = previous.content;
          previousContentTruncated = previous.truncated;
          previousContentOmittedBytes = Math.max(0, previous.totalBytes - Buffer.byteLength(previous.content, 'utf8'));
        } catch (error) {
          const code = typeof error === 'object' && error != null && 'code' in error ? (error as {code?: unknown}).code : undefined;
          if (code !== 'ENOENT') throw error;
          if (append) throw new HazeToolError(`Cannot append to missing file: ${filePath}. Create its first chunk with append=false.`, 'append_target_missing');
          await assertWritableInsideWorkspace();
        }
        await fs.mkdir(path.dirname(absolutePath), {recursive: true});
        const updated = append ? `${previousContent}${content}` : content;
        const writeDiff = fileDiff(previousContent, updated);
        if (append) await fs.appendFile(absolutePath, content, 'utf8');
        else await fs.writeFile(absolutePath, content, 'utf8');
        return {
          ok: true,
          path: filePath,
          bytes: contentBytes,
          overwritten: overwriteExisting,
          appended: append,
          noChange: targetExisted && !previousContentTruncated && previousContent === updated,
          addedLines: writeDiff.addedLines,
          removedLines: writeDiff.removedLines,
          diffComplete: !previousContentTruncated,
          ...(previousContentTruncated ? {previousContentOmittedBytes} : {}),
          ...mutationDiffFields(filePath, writeDiff.diff),
        };
      } catch (error) {
        return structuredToolFailure('writeFile', error, `Keep each content chunk at or below ${WRITE_FILE_CHUNK_BYTES} UTF-8 bytes. Create or replace the first chunk, then continue with append=true.`, filePath);
      }
    }),
  }),

  editFile: tool({
    description: 'Apply unique text replacements. Batch same-file edits; reread and use replaceLines if matching fails.',
    contextSchema: hazeToolContextSchema,
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
        const file = await readUtf8Prefix(absolutePath, EXACT_MUTATION_BYTES);
        if (file.truncated) throw new HazeToolError(`File exceeds ${EXACT_MUTATION_BYTES} byte exact-mutation limit`, 'file_too_large');
        const original = file.content;
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
        const changed = updated !== original;
        await fs.writeFile(absolutePath, updated, 'utf8');
        return {
          ok: true,
          path: filePath,
          edits: edits.length,
          approximateMatches: ranges.filter(range => range.approximate).length,
          noChange: !changed,
          addedLines: changed ? addedLines : 0,
          removedLines: changed ? removedLines : 0,
          ...mutationDiffFields(filePath, changed ? diff : []),
        };
      } catch (error) {
        return structuredToolFailure('editFile', error, 'Read the file again, then retry with exact current text or use replaceLines with the latest line numbers.', filePath);
      }
    }),
  }),

  writeTasks: writeTasksTool,

  readToolOutput: readToolOutputTool,

  fetch: fetchTool,

  shell: shellTool,

  process: processTool,

};
