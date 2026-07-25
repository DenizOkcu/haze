import {tool} from 'ai';
import {z} from 'zod';
import {classifyBashCommand, isValidationClassification} from '../../core/safety/bashClassifier.js';
import {parseValidationOutput} from '../../core/validation/outputParser.js';
import {filterBashOutput} from '../../core/bashOutput/registry.js';
import {storeToolOutput} from '../../core/agent/toolOutputStore.js';
import {workspaceRoot} from '../../utils/path.js';
import {compactStoredOutput, COMPACT_COMMAND_CHARS} from './outputCap.js';
import {hazeToolContextSchema, runDedupedTool} from './toolContext.js';
import {runBoundedProcess} from '../../core/process/runBoundedProcess.js';
import {BASH_STREAM_BYTES} from '../../core/limits/byteBudgets.js';

const SHORT_VALIDATION_CHARS = 2_000;

export const bashTool = tool({
  description: 'Run workspace tests, builds, validation, or inspection. Risk classification is informational; use file tools for edits.',
  contextSchema: hazeToolContextSchema,
  inputSchema: z.object({
    command: z.string().min(1).describe('Command to execute with bash -lc'),
    timeoutSeconds: z.number().int().positive().max(600).optional().describe('Timeout in seconds; defaults to 60'),
    allowMutation: z.boolean().default(false).describe('Deprecated compatibility flag. Commands run without confirmation; retained for compatibility.'),
  }),
  execute: async ({command, timeoutSeconds}, context) => runDedupedTool('bash', {command, timeoutSeconds}, context, async () => {
    const cwd = workspaceRoot();
    const classification = classifyBashCommand(command);
    const timeoutMs = (timeoutSeconds ?? 60) * 1000;
    const startedAt = Date.now();
    const processResult = await runBoundedProcess({command: 'bash', args: ['-lc', command], cwd, timeoutMs, signal: context.abortSignal, maxStdoutBytes: BASH_STREAM_BYTES, maxStderrBytes: BASH_STREAM_BYTES});
    const {code, timedOut} = processResult;
    const stdout = processResult.stdout.text;
    const stderr = processResult.stderr.text;
    const validationSummary = isValidationClassification(classification)
      ? parseValidationOutput({command, code, stdout, stderr, timedOut, stdoutTruncated: processResult.stdout.omittedBytes > 0, stderrTruncated: processResult.stderr.omittedBytes > 0, classification})
      : undefined;
    const validationPassed = validationSummary?.status === 'passed';
    const output = filterBashOutput({command, code, stdout, stderr, timedOut, classification, validationSummary, storeRawOutput: storeToolOutput, fallbackCompact: compactStoredOutput, compactMaxChars: validationPassed ? SHORT_VALIDATION_CHARS : COMPACT_COMMAND_CHARS});
    return {
      ok: code === 0 && !timedOut && !processResult.aborted && !processResult.error,
      code, command, cwd, classification, durationMs: Date.now() - startedAt, timedOut,
      aborted: processResult.aborted, signal: processResult.signal, forcedTermination: processResult.forced,
      stdout: output.stdout, stderr: output.stderr, validationSummary,
      stdoutBytes: processResult.stdout, stderrBytes: processResult.stderr,
      ...(processResult.error ? {error: processResult.error} : {}),
    };
  }),
});
