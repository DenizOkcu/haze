import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tool} from 'ai';
import {z} from 'zod';

const MAX_OUTPUT_CHARS = 50_000;

function workspaceRoot() {
  return process.cwd();
}

function resolveWorkspacePath(inputPath: string) {
  const root = workspaceRoot();
  const resolved = path.resolve(root, inputPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the workspace: ${inputPath}`);
  }
  return resolved;
}

function truncate(text: string, maxChars = MAX_OUTPUT_CHARS) {
  if (text.length <= maxChars) return {text, truncated: false};
  return {
    text: text.slice(0, maxChars),
    truncated: true,
    omittedChars: text.length - maxChars,
  };
}

export const hazeTools = {
  readFile: tool({
    description: 'Read a UTF-8 text file from the current workspace. Supports optional 1-based line offset and line limit.',
    inputSchema: z.object({
      path: z.string().describe('File path relative to the current workspace'),
      offset: z.number().int().positive().optional().describe('1-based line number to start reading from'),
      limit: z.number().int().positive().max(2000).optional().describe('Maximum number of lines to return'),
    }),
    execute: async ({path: filePath, offset, limit}) => {
      const absolutePath = resolveWorkspacePath(filePath);
      const content = await fs.readFile(absolutePath, 'utf8');
      const lines = content.split(/\r?\n/);
      const start = offset == null ? 0 : offset - 1;
      const end = limit == null ? lines.length : start + limit;
      const selected = lines.slice(start, end).join('\n');
      return {
        path: filePath,
        startLine: start + 1,
        endLine: Math.min(end, lines.length),
        totalLines: lines.length,
        ...truncate(selected),
      };
    },
  }),

  writeFile: tool({
    description: 'Create or overwrite a UTF-8 text file in the current workspace. Creates parent directories as needed.',
    inputSchema: z.object({
      path: z.string().describe('File path relative to the current workspace'),
      content: z.string().describe('Complete file contents to write'),
    }),
    execute: async ({path: filePath, content}) => {
      const absolutePath = resolveWorkspacePath(filePath);
      await fs.mkdir(path.dirname(absolutePath), {recursive: true});
      await fs.writeFile(absolutePath, content, 'utf8');
      return {ok: true, path: filePath, bytes: Buffer.byteLength(content, 'utf8')};
    },
  }),

  editFile: tool({
    description: 'Edit a text file using exact replacements. Each oldText must match exactly once in the original file and edits must not overlap.',
    inputSchema: z.object({
      path: z.string().describe('File path relative to the current workspace'),
      edits: z.array(z.object({
        oldText: z.string().min(1).describe('Exact text to replace; must appear exactly once'),
        newText: z.string().describe('Replacement text'),
      })).min(1).describe('One or more non-overlapping exact replacements'),
    }),
    execute: async ({path: filePath, edits}) => {
      const absolutePath = resolveWorkspacePath(filePath);
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
    },
  }),

  bash: tool({
    description: 'Run a bash command in the current workspace. Use for inspecting files, running tests, builds, and other shell tasks. Avoid destructive commands unless the user explicitly asked.',
    inputSchema: z.object({
      command: z.string().min(1).describe('Command to execute with bash -lc'),
      timeoutSeconds: z.number().int().positive().max(600).optional().describe('Timeout in seconds; defaults to 60'),
    }),
    execute: async ({command, timeoutSeconds}, {abortSignal}) => {
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
        abortSignal?.addEventListener('abort', abort, {once: true});
        child.stdout.on('data', data => stdout += data.toString());
        child.stderr.on('data', data => stderr += data.toString());
        child.on('close', code => {
          settled = true;
          clearTimeout(timer);
          abortSignal?.removeEventListener('abort', abort);
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
          abortSignal?.removeEventListener('abort', abort);
          resolve({ok: false, command, error: error.message});
        });
      });
    },
  }),
};

export type HazeTools = typeof hazeTools;
