import {spawn, type ChildProcess} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {BACKGROUND_PROCESS_HISTORY_LIMIT, BACKGROUND_PROCESS_MAX_CONCURRENCY} from '../agent/budgets.js';
import {registerDynamicToolOutput, unregisterDynamicToolOutput} from '../agent/toolOutputStore.js';
import {BACKGROUND_PROCESS_OUTPUT_BYTES} from '../limits.js';
import {signalProcessTree} from './runBoundedProcess.js';
import {shellInvocation} from './userShell.js';
import {truncateUtf8TailBufferAtBytes} from '../../utils/utf8.js';

type BackgroundProcessStatus = 'running' | 'exited' | 'failed' | 'killed';

export interface BackgroundProcessSummary {
  backgroundId: string;
  pid?: number;
  command: string;
  cwd: string;
  startedAt: string;
  status: BackgroundProcessStatus;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  outputHandle: string;
  outputBytes: {totalBytes: number; retainedBytes: number; omittedBytes: number};
  error?: string;
}

class OutputRing {
  private readonly decoder = new StringDecoder('utf8');
  private retained: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private totalBytes = 0;

  private appendText(completeText: string) {
    if (!completeText) return;
    const bytes = Buffer.from(completeText, 'utf8');
    this.retained = this.retained.length === 0 ? bytes : Buffer.concat([this.retained, bytes]);
    this.retained = truncateUtf8TailBufferAtBytes(this.retained, BACKGROUND_PROCESS_OUTPUT_BYTES).buffer;
  }

  add(chunk: Buffer) {
    this.totalBytes += chunk.length;
    this.appendText(this.decoder.write(chunk));
  }

  end() {
    this.appendText(this.decoder.end());
  }

  snapshot() {
    return {content: this.retained.toString('utf8'), totalBytes: this.totalBytes};
  }

  stats() {
    return {totalBytes: this.totalBytes, retainedBytes: this.retained.length, omittedBytes: Math.max(0, this.totalBytes - this.retained.length)};
  }
}

type BackgroundRecord = {
  child: ChildProcess;
  ring: OutputRing;
  closed: boolean;
  summary: Omit<BackgroundProcessSummary, 'outputBytes'>;
};

const records = new Map<string, BackgroundRecord>();
const listeners = new Set<() => void>();
let nextId = 1;
let exitHookInstalled = false;

function notify() {
  for (const listener of listeners) listener();
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', terminateBackgroundProcessesSync);
}

function activeRecords() {
  return [...records.values()].filter(record => record.summary.status === 'running');
}

function pruneCompletedRecords() {
  const completed = [...records.values()].filter(record => record.summary.status !== 'running');
  for (const record of completed.slice(0, Math.max(0, completed.length - BACKGROUND_PROCESS_HISTORY_LIMIT))) {
    records.delete(record.summary.backgroundId);
    unregisterDynamicToolOutput(record.summary.outputHandle);
  }
}

function publicSummary(record: BackgroundRecord): BackgroundProcessSummary {
  return {...record.summary, outputBytes: record.ring.stats()};
}

export function backgroundProcessCount() {
  return activeRecords().length;
}

export function subscribeBackgroundProcesses(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function listBackgroundProcesses(): BackgroundProcessSummary[] {
  return [...records.values()].map(publicSummary);
}

export function getBackgroundProcess(backgroundId: string): BackgroundProcessSummary | undefined {
  const record = records.get(backgroundId);
  return record ? publicSummary(record) : undefined;
}

export function startBackgroundProcess(input: {command: string; cwd: string}): BackgroundProcessSummary {
  if (activeRecords().length >= BACKGROUND_PROCESS_MAX_CONCURRENCY) {
    throw new Error(`Background process limit reached (${BACKGROUND_PROCESS_MAX_CONCURRENCY}). Kill an existing process with process action=kill, then retry.`);
  }
  installExitHook();
  const backgroundId = `background-${nextId++}`;
  const invocation = shellInvocation(input.command);
  const child = spawn(invocation.command, invocation.args, {
    cwd: input.cwd,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ring = new OutputRing();
  const outputHandle = registerDynamicToolOutput(() => ring.snapshot());
  const summary: BackgroundRecord['summary'] = {
    backgroundId,
    ...(child.pid == null ? {} : {pid: child.pid}),
    command: input.command,
    cwd: input.cwd,
    startedAt: new Date().toISOString(),
    status: 'running',
    outputHandle,
  };
  const record: BackgroundRecord = {child, ring, closed: false, summary};
  records.set(backgroundId, record);
  child.stdout?.on('data', (chunk: Buffer) => ring.add(chunk));
  child.stderr?.on('data', (chunk: Buffer) => ring.add(chunk));
  child.once('error', error => {
    summary.status = 'failed';
    const code = typeof error === 'object' && error != null && 'code' in error ? (error as {code?: unknown}).code : undefined;
    // Without the user's shell on PATH, spawn fails with ENOENT; surface a
    // clearer message than the raw syscall error. The default Windows shell is
    // bash (via WSL or Git Bash), so that case keeps the install hint.
    const shellName = invocation.command;
    summary.error = code === 'ENOENT' && process.platform === 'win32'
      ? `${shellName} was not found on PATH.${shellName === 'bash' ? ' Install WSL or Git Bash, or run haze on a POSIX shell.' : ''} Underlying error: ${error.message}`
      : error.message;
    notify();
  });
  child.once('close', (code, signal) => {
    record.closed = true;
    ring.end();
    summary.code = code;
    summary.signal = signal;
    if (summary.status === 'running') summary.status = 'exited';
    child.stdout?.destroy();
    child.stderr?.destroy();
    pruneCompletedRecords();
    notify();
  });
  notify();
  return publicSummary(record);
}

function waitForClose(record: BackgroundRecord, timeoutMs: number) {
  if (record.closed) return Promise.resolve(true);
  return new Promise<boolean>(resolve => {
    const timeout = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    timeout.unref?.();
    const onClose = () => { cleanup(); resolve(true); };
    const cleanup = () => { clearTimeout(timeout); record.child.off('close', onClose); };
    record.child.once('close', onClose);
  });
}

export async function killBackgroundProcess(backgroundId: string, killGraceMs = 500): Promise<BackgroundProcessSummary | undefined> {
  const record = records.get(backgroundId);
  if (!record) return undefined;
  if (record.summary.status !== 'running') return publicSummary(record);
  signalProcessTree(record.child, 'SIGTERM');
  let closed = await waitForClose(record, killGraceMs);
  if (!closed) {
    signalProcessTree(record.child, 'SIGKILL');
    closed = await waitForClose(record, 100);
    record.child.stdout?.destroy();
    record.child.stderr?.destroy();
  }
  const terminated = closed || record.child.exitCode != null || record.child.signalCode != null;
  if (terminated) record.summary.status = 'killed';
  else record.summary.error = `Failed to terminate process tree for ${backgroundId}.`;
  notify();
  return publicSummary(record);
}

/** Terminate every owned tree and clear the session-local registry and handles. */
export async function teardownBackgroundProcesses(killGraceMs = 500): Promise<BackgroundProcessSummary[]> {
  const active = activeRecords();
  const results = await Promise.all(active.map(record => killBackgroundProcess(record.summary.backgroundId, killGraceMs)));
  const tornDown = results.filter((result): result is BackgroundProcessSummary => result != null);
  const failures = tornDown.filter(result => result.status !== 'killed');
  if (failures.length > 0) throw new Error(`Failed to terminate background processes: ${failures.map(result => result.backgroundId).join(', ')}.`);
  for (const record of records.values()) unregisterDynamicToolOutput(record.summary.outputHandle);
  records.clear();
  notify();
  return tornDown;
}

let signalHandlersInstalled = false;

/** Install CLI-level abnormal-exit teardown for SIGINT and SIGTERM. */
export function installBackgroundProcessSignalHandlers() {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  const handle = (signal: 'SIGINT' | 'SIGTERM', exitCode: number) => {
    process.once(signal, () => {
      void teardownBackgroundProcesses(200).finally(() => process.exit(exitCode));
    });
  };
  handle('SIGINT', 130);
  handle('SIGTERM', 143);
}

/** Best-effort synchronous safety net for process.exit and otherwise unawaitable exits. */
function terminateBackgroundProcessesSync() {
  for (const record of activeRecords()) signalProcessTree(record.child, 'SIGTERM');
}

/** Test-only reset; callers should normally use teardownBackgroundProcesses. */
export async function resetBackgroundProcessesForTests() {
  await teardownBackgroundProcesses(25);
  nextId = 1;
}
