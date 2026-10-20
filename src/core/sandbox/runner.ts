import {buildSandboxBoundary, type SandboxBackend, type SandboxBoundary, type SandboxProfileName, type SandboxRuntimeFacts, type SandboxSettingsInput, type BlessedPathLike, defaultSandboxRuntimeFacts} from './boundary.js';
import {bubblewrapInvocation, type PosixIds} from './bubblewrap.js';
import {seatbeltInvocation} from './seatbelt.js';
import {sandboxUnavailableRemedy, type SandboxBackendInfo} from './detect.js';

/**
 * Sandbox composition: mode resolution (CLI flag → session override →
 * settings → built-in default, mirroring `--reasoning`) and spawn-target
 * wrapping. Pure argv construction — the bounded-process primitive in
 * `core/process` stays policy-free and keeps its tested timeout/abort/tree
 * teardown contracts.
 */

export type SandboxMode = 'auto' | 'on' | 'off';

/** Session-scoped `/sandbox` override, kept in memory on the PromptSession. */
export interface SandboxSessionOverride {
  mode?: SandboxMode;
  profile?: SandboxProfileName;
}

/** CLI `--sandbox` accepts both modes and profile names. */
export type SandboxCliOverride = SandboxMode | SandboxProfileName;

export interface ResolvedSandboxMode {
  /** The sandbox actually applies to child processes. */
  active: boolean;
  mode: SandboxMode;
  profile: SandboxProfileName;
  backend: SandboxBackend;
  /** Why inactive; present exactly when `active` is false. */
  reason?: 'mode_off' | 'no_backend';
  detail?: string;
}

export function resolveSandboxMode(input: {
  cliOverride?: SandboxCliOverride;
  sessionOverride?: SandboxSessionOverride;
  settings?: SandboxSettingsInput;
  backendInfo: SandboxBackendInfo;
}): ResolvedSandboxMode {
  const cli = input.cliOverride;
  const cliMode = cli === 'auto' || cli === 'on' || cli === 'off' ? cli : undefined;
  const cliProfile = cli === 'workspace' || cli === 'strict' ? cli : undefined;
  const mode = cliMode ?? input.sessionOverride?.mode ?? input.settings?.mode ?? 'auto';
  const profile = cliProfile ?? input.sessionOverride?.profile ?? input.settings?.profile ?? 'workspace';
  if (mode === 'off') return {active: false, mode, profile, backend: input.backendInfo.backend, reason: 'mode_off', detail: 'sandbox.mode is off'};
  if (input.backendInfo.backend === 'none') {
    return {active: false, mode, profile, backend: 'none', reason: 'no_backend', detail: input.backendInfo.detail};
  }
  return {active: true, mode, profile, backend: input.backendInfo.backend};
}

/** Everything a tool needs to spawn sandboxed children for one attempt. */
export interface SandboxRuntimeState {
  resolved: ResolvedSandboxMode;
  boundary?: SandboxBoundary;
  /** Remedy text when the backend is unavailable (for actionable failures). */
  remedy?: string;
}

export async function resolveSandboxRuntime(input: {
  workspaceRoot: string;
  blessedPaths?: readonly BlessedPathLike[];
  settings?: SandboxSettingsInput;
  backendInfo: SandboxBackendInfo;
  cliOverride?: SandboxCliOverride;
  sessionOverride?: SandboxSessionOverride;
  runtime?: SandboxRuntimeFacts;
  /** Helper executables (bundled ripgrep) that need read/exec runtime roots outside the workspace. */
  helperExecutables?: readonly string[];
}): Promise<SandboxRuntimeState> {
  const resolved = resolveSandboxMode(input);
  if (!resolved.active) {
    return resolved.reason === 'no_backend' ? {resolved, remedy: sandboxUnavailableRemedy(input.backendInfo)} : {resolved};
  }
  const boundary = await buildSandboxBoundary({
    workspaceRoot: input.workspaceRoot,
    blessedPaths: input.blessedPaths,
    settings: input.settings,
    runtime: input.runtime ?? defaultSandboxRuntimeFacts(),
    helperExecutables: input.helperExecutables,
  });
  return {resolved, boundary};
}

export interface ShellSandboxMetadata {
  enabled: boolean;
  backend: SandboxBackend;
  profile: SandboxProfileName;
  /** Present when enabled=false: why (mode off / backend unavailable). */
  reason?: string;
  denial?: {kind: 'read' | 'write' | 'exec' | 'network' | 'unknown'; pathHint?: string};
}

export type WrappedInvocation =
  | {invocation: {command: string; args: string[]}; sandbox: ShellSandboxMetadata}
  /** `mode: "on"` with no backend: refuse to run the command unsandboxed. */
  | {unavailable: true; error: string; sandbox: ShellSandboxMetadata};

function posixIds(): PosixIds {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
  return {uid, gid};
}

/**
 * Wrap a spawn target for the sandbox. With no state (older context, workers
 * assembled elsewhere) or an inactive sandbox this is a passthrough that
 * still reports truthful metadata. `mode: "on"` without a backend refuses
 * loudly instead of degrading (fail closed).
 */
export function wrapInvocation(
  target: {command: string; args: string[]},
  state: SandboxRuntimeState | undefined,
  options?: {ids?: PosixIds},
): WrappedInvocation {
  if (!state || !state.resolved.active || !state.boundary) {
    const metadataBase = {enabled: false, backend: state?.resolved.backend ?? 'none', profile: state?.resolved.profile ?? 'workspace'} as const;
    if (state?.resolved.mode === 'on' && state.resolved.reason === 'no_backend') {
      return {
        unavailable: true,
        error: `Sandbox mode is "on" but the OS sandbox backend is unavailable (${state.resolved.detail ?? 'unknown reason'}).`,
        sandbox: {...metadataBase, reason: state.resolved.reason},
      };
    }
    return {invocation: target, sandbox: {...metadataBase, ...(state?.resolved.reason ? {reason: state.resolved.reason} : {})}};
  }
  const {boundary, resolved} = state;
  const metadata: ShellSandboxMetadata = {enabled: true, backend: resolved.backend, profile: resolved.profile};
  if (resolved.backend === 'seatbelt') return {invocation: seatbeltInvocation(target, boundary), sandbox: metadata};
  if (resolved.backend === 'bubblewrap') return {invocation: bubblewrapInvocation(target, boundary, options?.ids ?? posixIds()), sandbox: metadata};
  return {invocation: target, sandbox: {...metadata, enabled: false, reason: 'no_backend'}};
}
