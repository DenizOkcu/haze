import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {GREP_STREAM_BYTES, PROCESS_STDERR_BYTES, TEXT_LINE_BYTES} from '../../core/limits/byteBudgets.js';

export async function runRipgrepBounded(input: {executable: string; args: string[]; cwd: string; maxMatches: number; timeoutMs?: number; signal?: AbortSignal}): Promise<{stdout: string; stderr: string; code: number | null; capped: boolean; timedOut: boolean; aborted: boolean}> {
  if (input.signal?.aborted) return {stdout: '', stderr: '', code: null, capped: false, timedOut: false, aborted: true};
  const child = spawn(input.executable, input.args, {cwd: input.cwd, stdio: ['ignore', 'pipe', 'pipe']});
  const decoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let pending = '';
  const lines: string[] = [];
  let stderr = '';
  let retainedBytes = 0;
  let stderrBytes = 0;
  let matches = 0;
  let capped = false;
  let timedOut = false;
  let aborted = false;
  let protocolError: string | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (!child.killed) child.kill('SIGTERM');
    forceTimer ??= setTimeout(() => child.kill('SIGKILL'), 500);
    forceTimer.unref?.();
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, input.timeoutMs ?? 30_000);
  const abort = () => { aborted = true; stop(); };
  input.signal?.addEventListener('abort', abort, {once: true});
  child.stdout.on('data', (chunk: Buffer) => {
    pending += decoder.write(chunk);
    if (Buffer.byteLength(pending, 'utf8') > TEXT_LINE_BYTES) {
      protocolError = `ripgrep JSON line exceeds ${TEXT_LINE_BYTES} bytes`;
      stop();
      return;
    }
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    for (const line of parts) {
      if (capped) continue;
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (retainedBytes + lineBytes > GREP_STREAM_BYTES) {
        capped = true;
        stop();
        break;
      }
      lines.push(line);
      retainedBytes += lineBytes;
      try { if ((JSON.parse(line) as {type?: string}).type === 'match') matches++; } catch { /* parser reports malformed data later */ }
      if (matches > input.maxMatches) { capped = true; stop(); }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const remaining = PROCESS_STDERR_BYTES - stderrBytes;
    if (remaining <= 0) return;
    const kept = chunk.subarray(0, remaining);
    stderrBytes += kept.length;
    stderr += stderrDecoder.write(kept);
  });
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      input.signal?.removeEventListener('abort', abort);
      const tail = pending + decoder.end();
      if (tail && !capped) lines.push(tail);
      stderr += stderrDecoder.end();
      if (protocolError) stderr = `${stderr}${stderr ? '\n' : ''}${protocolError}`;
      resolve({stdout: lines.join('\n'), stderr, code, capped, timedOut, aborted});
    });
  });
}
