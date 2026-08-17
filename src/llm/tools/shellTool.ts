import {tool} from 'ai';
import {z} from 'zod';
import {classifyShellCommand, isValidationClassification} from '../../core/safety/shellClassifier.js';
import {detectMissingExecutable, missingExecutableFields} from '../../core/safety/missingExecutable.js';
import {parseValidationOutput} from '../../core/validation/outputParser.js';
import {filterShellOutput} from '../../core/shellOutput/registry.js';
import {storeToolOutput} from '../../core/agent/toolOutputStore.js';
import {workspaceRoot} from '../../utils/path.js';
import {compactStoredOutput, COMPACT_COMMAND_CHARS} from './outputCap.js';
import {hazeContext, hazeToolContextSchema, runDedupedTool} from './toolContext.js';
import {runBoundedProcess, type BoundedStream} from '../../core/process/runBoundedProcess.js';
import {SHELL_STREAM_BYTES, SHORT_VALIDATION_CHARS} from '../../core/limits.js';
import {startBackgroundProcess} from '../../core/process/backgroundRegistry.js';
import {resolveUserShell, shellInvocation, shellSyntaxGuidance} from '../../core/process/userShell.js';

/** Byte-stat metadata only — the raw stream text must never reach the model context (see code-review CR-001). */
function streamByteStats(stream: BoundedStream) {
  return {totalBytes: stream.totalBytes, retainedBytes: stream.retainedBytes, omittedBytes: stream.omittedBytes};
}

const userShell = resolveUserShell();

export const shellTool = tool({
  description: 'Run workspace inspection or validation. Set purpose=validation for custom checks that should count as completion evidence; risk classification is informational.',
  contextSchema: hazeToolContextSchema,
  inputSchema: z.object({
    command: z.string().min(1).describe(`Command to execute with ${userShell} ${shellInvocation('', userShell).args.join(' ')}. ${shellSyntaxGuidance(userShell)}`.trim()),
    purpose: z.enum(['auto', 'validation']).default('auto').describe('Use validation for an intentional test/check command, including custom assertion scripts; pass/fail still comes from the real process result.'),
    timeoutSeconds: z.number().int().positive().max(600).optional().describe('Timeout in seconds; defaults to 60'),
    background: z.boolean().default(false).describe('Start a registered long-running process and return immediately. Use process to list, inspect output, or kill it.'),
  }),
  execute: async ({command, purpose, timeoutSeconds, background}, context) => runDedupedTool('shell', {command, purpose, timeoutSeconds, background}, context, async () => {
    const cwd = workspaceRoot();
    const classification = classifyShellCommand(command);
    // Note: secret-file protection is NOT hard-enforced here by decision — it
    // lives in the file tools (workspaceFile.ts / grep globs). For shell, the
    // behavior is instructed via the system prompt (SECRET_FILE_RULE).
    if (background) {
      if (hazeContext(context)?.isSubagent) {
        return {ok: false, command, reasonCode: 'background_not_allowed', recoverable: false, error: 'Background processes are available only to the main haze turn, not fleet workers.', suggestedNextStep: 'Run the server from the main conversation.'};
      }
      if (context.abortSignal?.aborted) {
        return {ok: false, command, reasonCode: 'aborted', recoverable: true, error: 'Background process was not started because the turn is already aborted.', suggestedNextStep: 'Retry when the turn is active.'};
      }
      try {
        const started = startBackgroundProcess({command, cwd});
        return {ok: true, background: true, ...started, classification, hint: `Use readToolOutput with handle ${started.outputHandle} for logs, or process action=kill backgroundId=${started.backgroundId} when done.`};
      } catch (error) {
        return {ok: false, background: true, command, reasonCode: 'background_limit', recoverable: true, error: error instanceof Error ? error.message : String(error), suggestedNextStep: 'List background processes and kill one before retrying.'};
      }
    }
    const timeoutMs = (timeoutSeconds ?? 60) * 1000;
    const startedAt = Date.now();
    const processResult = await runBoundedProcess({...shellInvocation(command), cwd, timeoutMs, signal: context.abortSignal, maxStdoutBytes: SHELL_STREAM_BYTES, maxStderrBytes: SHELL_STREAM_BYTES});
    const {code, timedOut} = processResult;
    const stdout = processResult.stdout.text;
    const stderr = processResult.stderr.text;
    const validationSummary = purpose === 'validation' || isValidationClassification(classification)
      ? parseValidationOutput({command, code, stdout, stderr, timedOut, stdoutTruncated: processResult.stdout.omittedBytes > 0, stderrTruncated: processResult.stderr.omittedBytes > 0, classification})
      : undefined;
    const validationPassed = validationSummary?.status === 'passed';
    const output = filterShellOutput({command, code, stdout, stderr, timedOut, classification, validationSummary, storeRawOutput: storeToolOutput, fallbackCompact: compactStoredOutput, compactMaxChars: validationPassed ? SHORT_VALIDATION_CHARS : COMPACT_COMMAND_CHARS});
    // Generic, dependency-agnostic diagnostic for a missing executable. Only the
    // executable name and a generic next step are exposed (never raw stderr).
    const missing = code !== 0 && !processResult.aborted ? detectMissingExecutable({command, code, stderr}) : undefined;
    return {
      ok: code === 0 && !timedOut && !processResult.aborted && !processResult.error,
      code, command, purpose, cwd, classification, durationMs: Date.now() - startedAt, timedOut,
      aborted: processResult.aborted, signal: processResult.signal, forcedTermination: processResult.forced,
      stdout: output.stdout, stderr: output.stderr, validationSummary,
      stdoutBytes: streamByteStats(processResult.stdout), stderrBytes: streamByteStats(processResult.stderr),
      ...(missing ? {...missingExecutableFields(missing), missingExecutableStep: missing.suggestedNextStep} : {}),
      ...(processResult.error ? {error: processResult.error} : {}),
    };
  }),
});
