import {spawn, type ChildProcess} from 'node:child_process';
import type {SandboxBackend} from './boundary.js';

/**
 * Sandbox backend availability probe. Effectful but bounded: one short-lived
 * child per backend candidate, a hard deadline, and a process-scoped cache
 * (`resetSandboxDetection()` is the test seam, per Constitution VI).
 *
 * Availability is probed, never assumed: `sandbox-exec` is deprecated by
 * Apple and bubblewrap depends on unprivileged user namespaces, which Ubuntu
 * ≥23.10 restricts via AppArmor. A missing or restricted backend degrades to
 * `none` with a classified reason that surfaces in `/sandbox`, `haze doctor`,
 * and (once per session) the chat UI.
 */

export type SandboxUnavailableReason = 'unsupported_platform' | 'missing_binary' | 'userns_denied' | 'probe_failed';

export interface SandboxBackendInfo {
  backend: SandboxBackend;
  reason?: SandboxUnavailableReason;
  /** Bounded stderr excerpt for diagnostics display. */
  detail?: string;
}

export interface DetectSandboxOptions {
  probeTimeoutMs?: number;
  /** @internal testing seam. */
  platform?: NodeJS.Platform;
  /** @internal testing seam. */
  spawnProcess?: typeof spawn;
  /** @internal testing seam. */
  now?: () => number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DETAIL_LIMIT = 200;

let cached: SandboxBackendInfo | undefined;
let inflight: Promise<SandboxBackendInfo> | undefined;

export function resetSandboxDetection(): void {
  cached = undefined;
  inflight = undefined;
}

function boundedDetail(text: string): string {
  return text.slice(-DETAIL_LIMIT).replace(/\s+/g, ' ').trim();
}

function runProbe(command: string, args: string[], options: DetectSandboxOptions): Promise<{code: number | null; error?: string; stderr: string}> {
  return new Promise(resolve => {
    let settled = false;
    let stderr = '';
    const timeout = setTimeout(() => {
      finish({code: null, error: `probe timed out after ${options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS}ms`});
    }, options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    const finish = (result: {code: number | null; error?: string}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({code: result.code, error: result.error, stderr});
    };
    let child: ChildProcess;
    try {
      child = (options.spawnProcess ?? spawn)(command, args, {stdio: ['ignore', 'ignore', 'pipe']});
    } catch (error) {
      clearTimeout(timeout);
      resolve({code: null, error: error instanceof Error ? error.message : String(error), stderr: ''});
      return;
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', error => finish({code: null, error: error instanceof Error ? error.message : String(error)}));
    child.on('close', code => finish({code}));
  });
}

function classifyUsernsFailure(stderr: string, error?: string): SandboxUnavailableReason {
  const haystack = `${stderr} ${error ?? ''}`.toLowerCase();
  if (haystack.includes('user namespace') || haystack.includes('userns') || haystack.includes('apparmor')) return 'userns_denied';
  return 'probe_failed';
}

export async function detectSandboxBackend(options: DetectSandboxOptions = {}): Promise<SandboxBackendInfo> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const platform = options.platform ?? process.platform;
    let info: SandboxBackendInfo;
    if (platform === 'darwin') {
      const probe = await runProbe('/usr/bin/sandbox-exec', ['-p', '(version 1)\n(allow default)', '--', '/usr/bin/true'], options);
      info = probe.code === 0
        ? {backend: 'seatbelt'}
        : probe.error?.includes('ENOENT') || probe.code === 71 && !probe.stderr
          ? {backend: 'none', reason: 'missing_binary', detail: 'sandbox-exec not found at /usr/bin/sandbox-exec'}
          : {backend: 'none', reason: 'probe_failed', detail: boundedDetail(probe.stderr || probe.error || `exit ${probe.code}`)};
    } else if (platform === 'linux') {
      const probe = await runProbe('bwrap', [
        '--unshare-user', '--unshare-ipc', '--unshare-uts', '--die-with-parent',
        '--ro-bind', '/usr', '/usr', '--ro-bind-try', '/etc', '/etc',
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
        '--', '/usr/bin/true',
      ], options);
      info = probe.code === 0
        ? {backend: 'bubblewrap'}
        : probe.error?.includes('ENOENT')
          ? {backend: 'none', reason: 'missing_binary', detail: 'bwrap not found on PATH (install the bubblewrap package)'}
          : {backend: 'none', reason: classifyUsernsFailure(probe.stderr, probe.error), detail: boundedDetail(probe.stderr || probe.error || `exit ${probe.code}`)};
    } else {
      info = {backend: 'none', reason: 'unsupported_platform', detail: `OS-level sandboxing is not available on ${platform}; file-tool confinement still applies`};
    }
    cached = info;
    return info;
  })();
  try {
    return await inflight;
  } finally {
    inflight = undefined;
  }
}

/** Human-readable remedy for an unavailable backend, used in tool results and `/sandbox`. */
export function sandboxUnavailableRemedy(info: SandboxBackendInfo): string {
  switch (info.reason) {
    case 'missing_binary':
      return info.backend === 'none' && process.platform === 'linux'
        ? 'Install bubblewrap (e.g. sudo apt install bubblewrap or the distro equivalent), or set sandbox.mode "off" in ~/.haze/settings.json.'
        : 'The OS sandbox backend is missing on this machine; set sandbox.mode "off" in ~/.haze/settings.json to run unsandboxed.';
    case 'userns_denied':
      return 'bubblewrap needs unprivileged user namespaces. Enable them (e.g. sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0 on Ubuntu 23.10+ or install a setuid bwrap), or set sandbox.mode "off".';
    case 'unsupported_platform':
      return 'OS-level sandboxing supports macOS (seatbelt) and Linux (bubblewrap). Commands run with application-level confinement only; sandbox.mode "on" is not available here.';
    default:
      return `Sandbox probe failed (${info.detail ?? 'unknown error'}). Set sandbox.mode "off" to run unsandboxed, or report the probe output.`;
  }
}
