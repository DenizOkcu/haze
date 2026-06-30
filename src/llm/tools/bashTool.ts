import {spawn} from 'node:child_process';
import {tool} from 'ai';
import {z} from 'zod';
import {classifyBashCommand, isValidationClassification} from '../../core/safety/bashClassifier.js';
import {parseValidationOutput} from '../../core/validation/outputParser.js';
import {filterBashOutput} from '../../core/bashOutput/registry.js';
import {storeToolOutput} from '../../core/agent/toolOutputStore.js';
import {workspaceRoot} from '../../utils/path.js';
import {compactStoredOutput, COMPACT_COMMAND_CHARS} from './outputCap.js';
import {runDedupedTool} from './toolContext.js';

const SHORT_VALIDATION_CHARS = 2_000;

export const bashTool = tool({
  description: 'Run workspace tests, builds, validation, or inspection. Use file tools for edits.',
  inputSchema: z.object({
    command: z.string().min(1).describe('Command to execute with bash -lc'),
    timeoutSeconds: z.number().int().positive().max(600).optional().describe('Timeout in seconds; defaults to 60'),
    allowMutation: z.boolean().default(false).describe('Deprecated compatibility flag. Commands run without confirmation; retained for compatibility.'),
  }),
  execute: async ({command, timeoutSeconds, allowMutation}, context) => runDedupedTool('bash', {command, timeoutSeconds, allowMutation}, context, async () => {
    const cwd = workspaceRoot();
    const classification = classifyBashCommand(command);
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
        const validationSummary = isValidationClassification(classification)
          ? parseValidationOutput({command, code, stdout, stderr, timedOut, stdoutTruncated: stdout.length > COMPACT_COMMAND_CHARS, stderrTruncated: stderr.length > COMPACT_COMMAND_CHARS, classification})
          : undefined;
        const validationPassed = validationSummary?.status === 'passed';
        const output = filterBashOutput({
          command,
          code,
          stdout,
          stderr,
          timedOut,
          classification,
          validationSummary,
          storeRawOutput: storeToolOutput,
          fallbackCompact: compactStoredOutput,
          compactMaxChars: validationPassed ? SHORT_VALIDATION_CHARS : COMPACT_COMMAND_CHARS,
        });
        resolve({
          ok: code === 0 && !timedOut,
          code,
          command,
          cwd,
          classification,
          durationMs: Date.now() - startedAt,
          timedOut,
          stdout: output.stdout,
          stderr: output.stderr,
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
});
