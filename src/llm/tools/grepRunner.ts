import {StringDecoder} from 'node:string_decoder';
import {runBoundedProcess} from '../../core/process/runBoundedProcess.js';
import {GREP_STREAM_BYTES, PROCESS_STDERR_BYTES, TEXT_LINE_BYTES} from '../../core/limits/byteBudgets.js';

/**
 * Line-oriented bounded ripgrep runner built on the shared bounded-process
 * primitive, so spawn/timeout/abort/process-group teardown behavior is
 * identical to bash (CR-004). Match counting and early-stop stay here.
 */
export async function runRipgrepBounded(input: {executable: string; args: string[]; cwd: string; maxMatches: number; timeoutMs?: number; signal?: AbortSignal}): Promise<{stdout: string; stderr: string; code: number | null; capped: boolean; timedOut: boolean; aborted: boolean}> {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const lines: string[] = [];
  let retainedBytes = 0;
  let matches = 0;
  let capped = false;
  let protocolError: string | undefined;

  const result = await runBoundedProcess({
    command: input.executable,
    args: input.args,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs ?? 30_000,
    signal: input.signal,
    // Raw stdout head is unused: line retention happens in the interceptor.
    maxStdoutBytes: 0,
    maxStderrBytes: PROCESS_STDERR_BYTES,
    onStdoutChunk: chunk => {
      pending += decoder.write(chunk);
      if (Buffer.byteLength(pending, 'utf8') > TEXT_LINE_BYTES) {
        protocolError = `ripgrep JSON line exceeds ${TEXT_LINE_BYTES} bytes`;
        return true;
      }
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      for (const line of parts) {
        if (capped) continue;
        const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
        if (retainedBytes + lineBytes > GREP_STREAM_BYTES) {
          capped = true;
          return true;
        }
        lines.push(line);
        retainedBytes += lineBytes;
        try { if ((JSON.parse(line) as {type?: string}).type === 'match') matches++; } catch { /* parser reports malformed data later */ }
        // Global match cap is enforced here (source of truth). The `--max-count`
        // flag passed to ripgrep is a per-file safeguard only (CR-021).
        if (matches > input.maxMatches) { capped = true; return true; }
      }
      return false;
    },
  });

  if (result.error) throw new Error(result.error);
  const tail = pending + decoder.end();
  if (tail && !capped) lines.push(tail);
  const stderr = result.stderr.text + (protocolError ? `${result.stderr.text ? '\n' : ''}${protocolError}` : '');
  return {stdout: lines.join('\n'), stderr, code: result.code, capped, timedOut: result.timedOut, aborted: result.aborted};
}
