import {tool} from 'ai';
import path from 'node:path';
import {z} from 'zod';
import {classifyShellCommand, commandMasksValidationExit, isValidationClassification} from '../../core/safety/shellClassifier.js';
import {detectMissingExecutable, missingExecutableFields} from '../../core/safety/missingExecutable.js';
import {parseValidationOutput} from '../../core/validation/outputParser.js';
import {filterShellOutput} from '../../core/shellOutput/registry.js';
import {storeToolOutput} from '../../core/agent/toolOutputStore.js';
import {workspaceRoot} from '../../utils/path.js';
import {compactStoredOutput, COMPACT_COMMAND_CHARS} from './outputCap.js';
import {hazeContext, hazeToolContextSchema, runDedupedTool} from './toolContext.js';
import {runBoundedProcess, type BoundedStream} from '../../core/process/runBoundedProcess.js';
import {wrapInvocation, type SandboxRuntimeState, type ShellSandboxMetadata} from '../../core/sandbox/runner.js';
import {classifySandboxDenial} from '../../core/sandbox/diagnostics.js';
import {recordSandboxDenial} from '../../core/sandbox/denialLog.js';
import {SHELL_STREAM_BYTES, SHORT_VALIDATION_CHARS} from '../../core/limits.js';
import {startBackgroundProcess} from '../../core/process/backgroundRegistry.js';
import {resolveUserShell, shellDialect, shellInvocation, shellSyntaxGuidance} from '../../core/process/userShell.js';

/** Byte-stat metadata only — the raw stream text must never reach the model context (see code-review CR-001). */
function streamByteStats(stream: BoundedStream) {
  return {totalBytes: stream.totalBytes, retainedBytes: stream.retainedBytes, omittedBytes: stream.omittedBytes};
}

const userShell = resolveUserShell();

export const shellTool = tool({
  description: 'Run workspace inspection or validation. Set purpose=validation for custom checks that should count as completion evidence; risk classification is informational. Commands may run inside an OS sandbox (see /sandbox): reads/writes are confined to the project, temp, and caches; when a sandbox boundary hint appears in a failed result, tell the user which path is needed instead of working around it.',
  contextSchema: hazeToolContextSchema,
  inputSchema: z.object({
    command: z.string().min(1).describe(`Command to execute with ${userShell} ${shellInvocation('', userShell).args.join(' ')}. ${shellSyntaxGuidance(userShell)}`.trim()),
    purpose: z.enum(['auto', 'validation']).default('auto').describe('Use validation for an intentional test/check command; known test/build commands are the authoritative completion evidence, custom checks supplement them. Pass/fail comes from the real process result.'),
    timeoutSeconds: z.number().int().positive().max(600).optional().describe('Timeout in seconds; defaults to 60'),
    background: z.boolean().default(false).describe('Start a registered long-running process and return immediately. Use process to list, inspect output, or kill it.'),
  }),
  execute: async ({command, purpose, timeoutSeconds, background}, context) => runDedupedTool('shell', {command, purpose, timeoutSeconds, background}, context, async () => {
    const cwd = workspaceRoot();
    const classification = classifyShellCommand(command);
    // OS sandbox (seatbelt/bubblewrap) for this attempt, if active. Fail
    // closed when mode is "on" but no backend exists: never run model
    // commands unsandboxed under an explicit requirement.
    const sandboxState = hazeContext(context)?.sandboxRuntime;
    if (sandboxState?.resolved.mode === 'on' && !sandboxState.resolved.active) {
      return {
        ok: false, command, reasonCode: 'sandbox_unavailable', recoverable: false,
        error: `Sandbox mode is "on" but the OS sandbox backend is unavailable (${sandboxState.resolved.detail ?? 'unknown reason'}).`,
        suggestedNextStep: sandboxState.remedy ?? 'Set sandbox.mode "auto" or "off" in ~/.haze/settings.json to run without the OS sandbox.',
        sandbox: {enabled: false, backend: 'none', profile: sandboxState.resolved.profile, reason: 'no_backend'},
      };
    }
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
        const started = startBackgroundProcess({command, cwd, sandboxRuntime: sandboxState});
        return {ok: true, background: true, ...started, classification, sandbox: backgroundSandboxMetadata(sandboxState), hint: `Use readToolOutput with handle ${started.outputHandle} for logs, or process action=kill backgroundId=${started.backgroundId} when done.`};
      } catch (error) {
        return {ok: false, background: true, command, reasonCode: 'background_limit', recoverable: true, error: error instanceof Error ? error.message : String(error), suggestedNextStep: 'List background processes and kill one before retrying.'};
      }
    }
    const timeoutMs = (timeoutSeconds ?? 60) * 1000;
    const startedAt = Date.now();
    // Validation exit codes must be truthful evidence: a pipeline like
    // `npm test | tail` otherwise reports the final stage's success while the
    // suite failed (found by the honest-impossibility eval). `pipefail` makes
    // any failing stage fail the pipeline; shells without it degrade to their
    // default pipeline semantics through the guarded `set` (POSIX shells only).
    const isValidationCommand = purpose === 'validation' || isValidationClassification(classification);
    const executionCommand = isValidationCommand && shellDialect(userShell) === 'posix' ? `set -o pipefail 2>/dev/null || true; ${command}` : command;
    const wrapped = wrapInvocation(shellInvocation(executionCommand), sandboxState);
    if ('unavailable' in wrapped) {
      return {ok: false, command, reasonCode: 'sandbox_unavailable', recoverable: false, error: wrapped.error, suggestedNextStep: sandboxState?.remedy ?? 'Set sandbox.mode "auto" or "off" in ~/.haze/settings.json to run without the OS sandbox.', sandbox: wrapped.sandbox};
    }
    const processResult = await runBoundedProcess({...wrapped.invocation, cwd, timeoutMs, signal: context.abortSignal, maxStdoutBytes: SHELL_STREAM_BYTES, maxStderrBytes: SHELL_STREAM_BYTES});
    const {code, timedOut} = processResult;
    const stdout = processResult.stdout.text;
    const stderr = processResult.stderr.text;
    // A spawn failure (executable missing / not found, exit 127) is an
    // environment blocker, not a failed check: nothing ran, so there is no
    // pass/fail evidence to record (observed 2026-10-04: a `missing_executable`
    // shell result was recorded as a failed `test` validation and rode a goal
    // checkpoint as an unresolvable red). Diagnose it below and keep the
    // validation summary absent.
    const missing = code !== 0 && !processResult.aborted ? detectMissingExecutable({command, code, stderr}) : undefined;
    const validationSummary = isValidationCommand && !missing
      ? parseValidationOutput({command, code, stdout, stderr, timedOut, stdoutTruncated: processResult.stdout.omittedBytes > 0, stderrTruncated: processResult.stderr.omittedBytes > 0, classification})
      : undefined;
    // Evidence truthfulness: a passing validation whose command shape can
    // mask an earlier failing stage (`npm test > out; cat out` ends with the
    // last stage's status) is demoted to unconfirmed — generic kind — so the
    // completion gate cannot treat it as authoritative (found by the
    // honest-impossibility eval). Failing validations keep their kind: a
    // masked compound that still failed is honestly failed.
    const authoritative = validationSummary == null || validationSummary.status !== 'passed' || !commandMasksValidationExit(command);
    const confirmedValidationSummary = validationSummary && authoritative
      ? validationSummary
      : validationSummary
        ? {...validationSummary, kind: 'generic' as const, summaryText: `${validationSummary.summaryText ?? ''} (compound command: exit-code provenance unconfirmed)`.trim()}
        : undefined;
    const validationPassed = confirmedValidationSummary?.status === 'passed';
    const output = filterShellOutput({command, code, stdout, stderr, timedOut, classification, validationSummary: confirmedValidationSummary, storeRawOutput: storeToolOutput, fallbackCompact: compactStoredOutput, compactMaxChars: validationPassed ? SHORT_VALIDATION_CHARS : COMPACT_COMMAND_CHARS});
    // Post-hoc boundary diagnostics: classify conservatively so unrelated
    // failures keep their ordinary meaning (missing executable diagnosis
    // above keeps priority when both apply).
    const denial = code !== 0 && !timedOut && !processResult.aborted && !missing && sandboxState?.boundary
      ? await classifySandboxDenial({code, stderr, boundary: sandboxState.boundary})
      : undefined;
    if (denial) {
      // Deterministic surfacing: the audit log always records it, and the
      // context callback lets the UI post a once-per-path notice during the
      // turn — the user learns about the boundary without relying on the
      // model relaying the failure.
      recordSandboxDenial({command, kind: denial.kind, ...(denial.pathHint ? {pathHint: denial.pathHint} : {})});
      hazeContext(context)?.onSandboxDenial?.(denial, command);
    }
    const sandbox: ShellSandboxMetadata = denial ? {...wrapped.sandbox, denial} : wrapped.sandbox;
    return {
      ok: code === 0 && !timedOut && !processResult.aborted && !processResult.error,
      code, command, purpose, cwd, classification, durationMs: Date.now() - startedAt, timedOut,
      aborted: processResult.aborted, signal: processResult.signal, forcedTermination: processResult.forced,
      stdout: output.stdout, stderr: output.stderr, validationSummary: confirmedValidationSummary,
      stdoutBytes: streamByteStats(processResult.stdout), stderrBytes: streamByteStats(processResult.stderr),
      sandbox,
      ...(denial ? {reasonCode: 'sandbox_boundary' as const, recoverable: true, suggestedNextStep: `Sandbox boundary: the command could not ${denial.kind === 'write' ? 'write' : 'access'} ${denial.pathHint ?? 'a path outside the sandbox'}. Ask the user to run /sandbox grant ${denial.pathHint ? path.dirname(denial.pathHint) : '<directory>'}${denial.kind === 'write' ? ' --rw' : ''} (persistent grant), @mention the path in the prompt (read for this turn), or run /sandbox off.`} : {}),
      ...(missing ? {...missingExecutableFields(missing), missingExecutableStep: missing.suggestedNextStep} : {}),
      ...(processResult.error ? {error: processResult.error} : {}),
    };
  }),
});

/** Truthful sandbox metadata for background starts (denials surface through process output reads). */
function backgroundSandboxMetadata(state: SandboxRuntimeState | undefined): ShellSandboxMetadata {
  if (!state) return {enabled: false, backend: 'none', profile: 'workspace'};
  return {
    enabled: state.resolved.active,
    backend: state.resolved.backend,
    profile: state.resolved.profile,
    ...(state.resolved.active ? {} : {reason: state.resolved.reason}),
  };
}
