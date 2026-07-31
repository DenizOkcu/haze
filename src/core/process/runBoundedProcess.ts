import {spawn, type ChildProcess} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';

export interface BoundedStream {text: string; totalBytes: number; retainedBytes: number; omittedBytes: number}
export interface BoundedProcessResult {code: number | null; signal: NodeJS.Signals | null; stdout: BoundedStream; stderr: BoundedStream; timedOut: boolean; aborted: boolean; forced: boolean; durationMs: number; error?: string}

export function signalProcessTree(child: Pick<ChildProcess, 'pid' | 'kill'>, signal: NodeJS.Signals) {
  if (child.pid == null) {
    child.kill(signal);
    return;
  }
  if (process.platform === 'win32') {
    if (signal === 'SIGKILL') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {stdio: 'ignore'}).unref();
    else child.kill('SIGTERM');
    return;
  }
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}

function collector(limit: number) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let retainedBytes = 0;
  return {
    add(chunk: Buffer) {
      totalBytes += chunk.length;
      const remaining = limit - retainedBytes;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        retainedBytes += kept.length;
      }
    },
    result(): BoundedStream {
      const decoder = new StringDecoder('utf8');
      const text = chunks.map(chunk => decoder.write(chunk)).join('') + (totalBytes === retainedBytes ? decoder.end() : '');
      return {text, totalBytes, retainedBytes, omittedBytes: totalBytes - retainedBytes};
    },
  };
}

export async function runBoundedProcess(input: {command: string; args: string[]; cwd: string; timeoutMs: number; signal?: AbortSignal; maxStdoutBytes: number; maxStderrBytes: number; killGraceMs?: number}): Promise<BoundedProcessResult> {
  const startedAt = Date.now();
  const stdout = collector(input.maxStdoutBytes);
  const stderr = collector(input.maxStderrBytes);
  if (input.signal?.aborted) {
    return {code: null, signal: null, stdout: stdout.result(), stderr: stderr.result(), timedOut: false, aborted: true, forced: false, durationMs: 0};
  }
  const detached = process.platform !== 'win32';
  const child = spawn(input.command, input.args, {cwd: input.cwd, detached, stdio: ['ignore', 'pipe', 'pipe']});
  let timedOut = false;
  let aborted = false;
  let forced = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let terminating = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const killTree = (signal: NodeJS.Signals) => signalProcessTree(child, signal);
  const stdoutData = (chunk: Buffer) => stdout.add(chunk);
  const stderrData = (chunk: Buffer) => stderr.add(chunk);
  child.stdout.on('data', stdoutData);
  child.stderr.on('data', stderrData);

  return await new Promise(resolve => {
    let settled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (closeTimer) clearTimeout(closeTimer);
      input.signal?.removeEventListener('abort', onAbort);
      child.stdout.off('data', stdoutData);
      child.stderr.off('data', stderrData);
      const stdoutResult = stdout.result();
      const stderrResult = stderr.result();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({code, signal, stdout: stdoutResult, stderr: stderrResult, timedOut, aborted, forced, durationMs: Date.now() - startedAt, ...(error ? {error} : {})});
    };
    const scheduleCloseFallback = () => {
      closeTimer ??= setTimeout(() => settle(exitCode, exitSignal), 50);
      closeTimer.unref?.();
    };
    const terminate = () => {
      if (terminating || settled) return;
      terminating = true;
      killTree('SIGTERM');
      killTimer = setTimeout(() => {
        forced = true;
        killTree('SIGKILL');
        scheduleCloseFallback();
      }, input.killGraceMs ?? 500);
      killTimer.unref?.();
    };
    const timeout = setTimeout(() => { timedOut = true; terminate(); }, input.timeoutMs);
    const onAbort = () => { aborted = true; terminate(); };
    input.signal?.addEventListener('abort', onAbort, {once: true});
    child.once('error', error => settle(null, null, error.message));
    child.once('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.once('close', (code, signal) => settle(code, signal));
  });
}
