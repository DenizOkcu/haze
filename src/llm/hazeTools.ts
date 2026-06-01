import {execFile as execFileCallback, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tool} from 'ai';
import {z} from 'zod';
import {walkDir} from '../utils/fs.js';
import {workspaceRoot, resolveWorkspacePath, workspaceRelativePath} from '../utils/path.js';

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

async function assertNotIgnored(absolutePath: string, inputPath: string, allowIgnored?: boolean) {
  if (!allowIgnored && await isGitIgnored(absolutePath)) {
    throw new Error(`Path is ignored by .gitignore: ${inputPath}. Set allowIgnored=true only if you explicitly need to access ignored files.`);
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

type ToolExecutionContext = {
  abortSignal?: AbortSignal;
  experimental_context?: unknown;
};

type HazeToolContext = {
  inFlightToolCalls?: Map<string, Promise<unknown>>;
  completedToolCalls?: Map<string, number>;
  mutationEpoch?: number;
  failedMutationPaths?: Set<string>;
  pathsReadAfterFailedMutation?: Set<string>;
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
  return ['listFiles', 'readFile'].includes(toolName);
}

function inputPath(input: unknown) {
  return typeof input === 'object' && input != null && 'path' in input && typeof (input as {path?: unknown}).path === 'string'
    ? (input as {path: string}).path
    : undefined;
}

async function runDedupedTool<T>(toolName: string, input: unknown, context: ToolExecutionContext, execute: () => Promise<T>): Promise<T | {ok: true; duplicateSkipped: true; toolName: string; reason: string}> {
  const ctx = hazeContext(context);
  if (!ctx) return execute();
  ctx.inFlightToolCalls ??= new Map();
  ctx.completedToolCalls ??= new Map();
  ctx.failedMutationPaths ??= new Set();
  ctx.pathsReadAfterFailedMutation ??= new Set();
  ctx.mutationEpoch ??= 0;
  const key = toolCallKey(toolName, input);
  const pathForInput = inputPath(input);
  if (isMutatingTool(toolName) && pathForInput && ctx.failedMutationPaths.has(pathForInput) && !ctx.pathsReadAfterFailedMutation.has(pathForInput)) {
    throw new Error(`Read ${pathForInput} before attempting another edit after the previous edit failure.`);
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

  const promise = execute();
  ctx.inFlightToolCalls.set(key, promise);
  try {
    const result = await promise;
    if (toolName === 'readFile' && pathForInput) ctx.pathsReadAfterFailedMutation.add(pathForInput);
    if (isMutatingTool(toolName)) {
      ctx.mutationEpoch += 1;
      if (pathForInput) {
        ctx.failedMutationPaths.delete(pathForInput);
        ctx.pathsReadAfterFailedMutation.delete(pathForInput);
      }
    }
    ctx.completedToolCalls.set(key, ctx.mutationEpoch);
    return result;
  } catch (error) {
    if (isMutatingTool(toolName) && pathForInput) {
      ctx.failedMutationPaths.add(pathForInput);
      ctx.pathsReadAfterFailedMutation.delete(pathForInput);
    }
    throw error;
  } finally {
    ctx.inFlightToolCalls.delete(key);
  }
}

export const hazeTools = {
  listFiles: tool({
    description: 'List files and directories in the current workspace. Prefer this over bash ls/find for discovering project structure.',
    inputSchema: z.object({
      path: z.string().default('.').describe('Directory path relative to the current workspace'),
      recursive: z.boolean().default(false).describe('Whether to list files recursively'),
      maxEntries: z.number().int().positive().max(500).default(100).describe('Maximum number of entries to return'),
      includeIgnored: z.boolean().default(false).describe('Include files ignored by .gitignore. Use only when explicitly needed.'),
    }),
    execute: async ({path: dirPath, recursive, maxEntries, includeIgnored}, context) => runDedupedTool('listFiles', {path: dirPath, recursive, maxEntries, includeIgnored}, context, async () => {
      const absolutePath = resolveWorkspacePath(dirPath);
      await assertNotIgnored(absolutePath, dirPath, includeIgnored);
      const entries: Array<{path: string; type: 'file' | 'directory'; size?: number}> = [];
      let ignoredSkipped = 0;

      const walked = await walkDir(absolutePath, {recursive, maxEntries, filter: async entry => {
        if (!includeIgnored && await isGitIgnored(entry.absolutePath)) { ignoredSkipped++; return false; }
        return true;
      }});

      for (const entry of walked) {
        if (entry.isDirectory) {
          entries.push({path: entry.path, type: 'directory'});
        } else if (entry.isFile) {
          const stat = await fs.stat(entry.absolutePath);
          entries.push({path: entry.path, type: 'file', size: stat.size});
        }
      }

      return {path: dirPath, recursive, includeIgnored, ignoredSkipped, entries, truncated: entries.length >= maxEntries};
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
    }),
  }),

  replaceLines: tool({
    description: 'Replace a 1-based inclusive line range in an existing UTF-8 text file. Prefer this after reading a file when exact editFile replacements are ambiguous or fail.',
    inputSchema: z.object({
      path: z.string().describe('File path relative to the current workspace'),
      startLine: z.number().int().positive().describe('First 1-based line number to replace'),
      endLine: z.number().int().positive().describe('Last 1-based line number to replace, inclusive'),
      content: z.string().describe('Replacement content for the line range'),
      allowIgnored: z.boolean().default(false).describe('Edit the file even if it is ignored by .gitignore. Use only when explicitly needed.'),
    }),
    execute: async ({path: filePath, startLine, endLine, content, allowIgnored}, context) => runDedupedTool('replaceLines', {path: filePath, startLine, endLine, content, allowIgnored}, context, async () => {
      if (endLine < startLine) throw new Error('endLine must be greater than or equal to startLine');
      const absolutePath = resolveWorkspacePath(filePath);
      await assertNotIgnored(absolutePath, filePath, allowIgnored);
      const original = await fs.readFile(absolutePath, 'utf8');
      const hasTrailingNewline = original.endsWith('\n');
      const lines = original.split(/\r?\n/);
      if (hasTrailingNewline) lines.pop();
      if (startLine > lines.length + 1) throw new Error(`startLine ${startLine} is beyond end of file (${lines.length} lines)`);
      if (endLine > lines.length) throw new Error(`endLine ${endLine} is beyond end of file (${lines.length} lines)`);
      const replacementLines = content.length === 0 ? [] : content.split(/\r?\n/);
      lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
      const updated = lines.join('\n') + (hasTrailingNewline ? '\n' : '');
      await fs.writeFile(absolutePath, updated, 'utf8');
      return {ok: true, path: filePath, startLine, endLine, replacementLines: replacementLines.length};
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
      const absolutePath = resolveWorkspacePath(filePath);
      await assertNotIgnored(absolutePath, filePath, allowIgnored);
      try {
        await fs.access(absolutePath);
        if (!overwriteExisting) {
          throw new Error(`Refusing to overwrite existing file: ${filePath}. Use editFile/replaceLines for targeted edits, or set overwriteExisting=true for an intentional complete rewrite.`);
        }
      } catch (error) {
        const code = typeof error === 'object' && error != null && 'code' in error ? (error as {code?: unknown}).code : undefined;
        if (code !== 'ENOENT') throw error;
      }
      await fs.mkdir(path.dirname(absolutePath), {recursive: true});
      await fs.writeFile(absolutePath, content, 'utf8');
      return {ok: true, path: filePath, bytes: Buffer.byteLength(content, 'utf8'), overwritten: overwriteExisting};
    }),
  }),

  editFile: tool({
    description: 'Edit a text file using exact replacements. Each oldText must match exactly once in the original file and edits must not overlap. If this fails because text is missing or not unique, do not retry; use replaceLines instead.',
    inputSchema: z.object({
      path: z.string().describe('File path relative to the current workspace'),
      edits: z.array(z.object({
        oldText: z.string().min(1).describe('Exact text to replace; must appear exactly once'),
        newText: z.string().describe('Replacement text'),
      })).min(1).describe('One or more non-overlapping exact replacements'),
      allowIgnored: z.boolean().default(false).describe('Edit the file even if it is ignored by .gitignore. Use only when explicitly needed.'),
    }),
    execute: async ({path: filePath, edits, allowIgnored}, context) => runDedupedTool('editFile', {path: filePath, edits, allowIgnored}, context, async () => {
      const absolutePath = resolveWorkspacePath(filePath);
      await assertNotIgnored(absolutePath, filePath, allowIgnored);
      const original = await fs.readFile(absolutePath, 'utf8');
      const ranges = edits.map((edit, index) => {
        const first = original.indexOf(edit.oldText);
        if (first === -1) throw new Error(`edit ${index}: oldText was not found`);
        const second = original.indexOf(edit.oldText, first + edit.oldText.length);
        if (second !== -1) throw new Error(`edit ${index}: oldText is not unique`);
        return {index, start: first, end: first + edit.oldText.length, edit};
      }).sort((a, b) => a.start - b.start);

      for (let i = 1; i < ranges.length; i++) {
        if (ranges[i]!.start < ranges[i - 1]!.end) {
          throw new Error(`edits ${ranges[i - 1]!.index} and ${ranges[i]!.index} overlap`);
        }
      }

      let updated = original;
      for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
        updated = updated.slice(0, range.start) + range.edit.newText + updated.slice(range.end);
      }
      await fs.writeFile(absolutePath, updated, 'utf8');
      return {ok: true, path: filePath, edits: edits.length};
    }),
  }),

  bash: tool({
    description: 'Run a bash command in the current workspace. Use for inspecting files, running tests, builds, and other shell tasks. Avoid destructive commands unless the user explicitly asked.',
    inputSchema: z.object({
      command: z.string().min(1).describe('Command to execute with bash -lc'),
      timeoutSeconds: z.number().int().positive().max(600).optional().describe('Timeout in seconds; defaults to 60'),
    }),
    execute: async ({command, timeoutSeconds}, context) => runDedupedTool('bash', {command, timeoutSeconds}, context, async () => {
      const timeoutMs = (timeoutSeconds ?? 60) * 1000;
      return await new Promise(resolve => {
        const child = spawn('bash', ['-lc', command], {cwd: workspaceRoot(), stdio: ['ignore', 'pipe', 'pipe']});
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) child.kill('SIGTERM');
        }, timeoutMs);
        const abort = () => child.kill('SIGTERM');
        context.abortSignal?.addEventListener('abort', abort, {once: true});
        child.stdout.on('data', data => stdout += data.toString());
        child.stderr.on('data', data => stderr += data.toString());
        child.on('close', code => {
          settled = true;
          clearTimeout(timer);
          context.abortSignal?.removeEventListener('abort', abort);
          resolve({
            ok: code === 0,
            code,
            command,
            stdout: truncate(stdout),
            stderr: truncate(stderr),
          });
        });
        child.on('error', error => {
          settled = true;
          clearTimeout(timer);
          context.abortSignal?.removeEventListener('abort', abort);
          resolve({ok: false, command, error: error.message});
        });
      });
    }),
  }),
};

export type HazeTools = typeof hazeTools;
