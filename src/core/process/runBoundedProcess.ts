import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';

export interface BoundedStream {text: string; totalBytes: number; retainedBytes: number; omittedBytes: number}
export interface BoundedProcessResult {code: number | null; signal: NodeJS.Signals | null; stdout: BoundedStream; stderr: BoundedStream; timedOut: boolean; aborted: boolean; forced: boolean; durationMs: number; error?: string}

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
  const killTree = (signal: NodeJS.Signals) => {
    if (child.pid == null) return;
    if (process.platform === 'win32') {
      if (signal === 'SIGKILL') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {stdio: 'ignore'}).unref();
      else child.kill('SIGTERM');
    } else {
      try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
    }
  };
  const terminate = () => {
    killTree('SIGTERM');
    killTimer ??= setTimeout(() => { forced = true; killTree('SIGKILL'); }, input.killGraceMs ?? 500);
    killTimer.unref?.();
  };
  const timeout = setTimeout(() => { timedOut = true; terminate(); }, input.timeoutMs);
  const onAbort = () => { aborted = true; terminate(); };
  input.signal?.addEventListener('abort', onAbort, {once: true});
  child.stdout.on('data', (chunk: Buffer) => stdout.add(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.add(chunk));
  return await new Promise(resolve => {
    let settled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      input.signal?.removeEventListener('abort', onAbort);
      resolve({code, signal, stdout: stdout.result(), stderr: stderr.result(), timedOut, aborted, forced, durationMs: Date.now() - startedAt, ...(error ? {error} : {})});
    };
    child.once('error', error => settle(null, null, error.message));
    child.once('close', (code, signal) => settle(code, signal));
  });
}
