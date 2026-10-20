import os from 'node:os';
import path from 'node:path';
import {detectSandboxBackend, sandboxUnavailableRemedy} from '../../core/sandbox/detect.js';
import {resolveSandboxRuntime, type SandboxSessionOverride} from '../../core/sandbox/runner.js';
import {isProtectedSecretPath} from '../../core/safety/secretPaths.js';
import type {PromptSession} from '../../llm/systemPrompt.js';
import type {HazeSettings, HazeSandboxSettings} from '../../config/settings.js';
import type {CommandContext, CommandResult} from './commands.js';

/**
 * `/sandbox` — OS sandbox status and session-scoped control (mode/profile),
 * modeled on `/reasoning`: overrides live on the `PromptSession` in memory,
 * never in `~/.haze/settings.json`. Persistent root grants (`/sandbox grant`)
 * are the exception: they are the documented write path for
 * `sandbox.roRoots`/`rwRoots` because paths outside the boundary (often
 * credential-bearing tool config) must be granted explicitly by the user,
 * once, instead of being default-mounted. Applies from the next turn — the
 * boundary is built once per attempt in `attemptSetup`.
 */

export type SandboxCommandResult =
  | {action: 'status'; message: string}
  | {action: 'set'; override: SandboxSessionOverride; message: string}
  | {action: 'error'; message: string};

function tildeShort(path: string, homedir: string): string {
  return path === homedir ? '~' : path.startsWith(`${homedir}/`) ? `~${path.slice(homedir.length)}` : path;
}

function describeRoots(roots: readonly {path: string; access: string; origin: string}[], homedir: string): string {
  const rw = roots.filter(root => root.access === 'rw').map(root => tildeShort(root.path, homedir));
  const ro = roots.filter(root => root.access === 'ro').map(root => tildeShort(root.path, homedir));
  return [
    `read-write : ${rw.length > 0 ? rw.join(', ') : '(none)'}`,
    `read-only  : ${ro.length > 0 ? ro.join(', ') : '(none)'}`,
  ].join('\n');
}

/** Pure result function shared by the slash path and tests. */
export async function resolveSandboxCommand(args: string, input: {
  settings: HazeSettings;
  sessionOverride?: PromptSession['sandboxOverride'];
  backendInfo: Awaited<ReturnType<typeof detectSandboxBackend>>;
  workspaceRoot: string;
  homedir: string;
  /** Deterministic facts for tests; production uses the live process. */
  runtime?: Parameters<typeof resolveSandboxRuntime>[0]['runtime'];
}): Promise<SandboxCommandResult> {
  const value = args.trim().toLowerCase();
  if (value === 'auto' || value === 'on' || value === 'off') {
    return {action: 'set', override: {mode: value}, message: `Sandbox mode set to ${value} for this session (in-memory; not written to settings). ${value === 'off' ? 'Commands run unsandboxed from the next turn.' : 'Applies from the next turn.'}`};
  }
  if (value === 'workspace' || value === 'strict') {
    return {action: 'set', override: {profile: value}, message: `Sandbox profile set to ${value} for this session (in-memory; not written to settings). ${value === 'strict' ? 'Network is denied and caches are read-only from the next turn.' : 'Network is allowed and caches are writable from the next turn.'}`};
  }
  if (value === 'reset') {
    return {action: 'set', override: {}, message: 'Session sandbox override removed; the saved sandbox settings (or built-in defaults) apply from the next turn.'};
  }
  if (value === 'test' || value === 'status') {
    // `test` runs live probes in the handler; fall through to the status card.
  } else if (value) {
    return {action: 'error', message: `Unknown /sandbox argument "${args.trim()}". Usage: /sandbox [auto|on|off|workspace|strict|reset|test|status|grant [--rw] <path>|revoke <path>].`};
  }

  const runtime = await resolveSandboxRuntime({workspaceRoot: input.workspaceRoot, settings: input.settings.sandbox, backendInfo: input.backendInfo, sessionOverride: input.sessionOverride, runtime: input.runtime});
  const {resolved} = runtime;
  const modeSource = input.sessionOverride?.mode ? 'session' : input.settings.sandbox?.mode ? 'settings' : 'default';
  const profileSource = input.sessionOverride?.profile ? 'session' : input.settings.sandbox?.profile ? 'settings' : 'default';
  const backendLine = resolved.backend === 'none'
    ? `unavailable (${resolved.reason === 'no_backend' ? input.backendInfo.reason ?? 'probe failed' : resolved.reason}): ${input.backendInfo.detail ?? 'unknown reason'}`
    : resolved.backend;
  const lines = [
    `OS sandbox: ${resolved.active ? `active via ${backendLine}` : `inactive — ${backendLine}`}`,
    `mode: ${resolved.mode} (${modeSource}) · profile: ${resolved.profile} (${profileSource}) · network: ${runtime.boundary?.network ?? (resolved.profile === 'strict' ? 'deny' : 'allow')}`,
  ];
  if (runtime.boundary) {
    lines.push(describeRoots(runtime.boundary.roots, input.homedir));
    lines.push(`masked credentials: ${runtime.boundary.masks.length} path${runtime.boundary.masks.length === 1 ? '' : 's'} inside ~/.haze and ~/.claude`);
  } else if (resolved.reason === 'no_backend') {
    lines.push(sandboxUnavailableRemedy(input.backendInfo));
  } else {
    lines.push('Set a mode with /sandbox auto|on|off. Grant filesystem access outside the boundary persistently with /sandbox grant [--rw] <path> (e.g. a tool config or module-cache directory); @mentioning a path grants it a read for one turn. Raw defaults: sandbox.* in ~/.haze/settings.json.');
  }
  return {action: 'status', message: lines.join('\n')};
}

export type SandboxGrantResult =
  | {action: 'granted' | 'revoked' | 'noop' | 'error'; message: string; sandbox?: HazeSandboxSettings};

function expandRoot(root: string, homedir: string): string {
  if (root === '~') return homedir;
  if (root.startsWith('~/')) return path.join(homedir, root.slice(2));
  return path.resolve(root);
}

/**
 * Pure grant/revoke computation for `/sandbox grant [--rw] <path>…` and
 * `/sandbox revoke <path>…`. Grants persist via `sandbox.roRoots`/`rwRoots`;
 * protected-secret paths are refused loudly (same trust rule as settings
 * validation). Duplicate grants are idempotent no-ops.
 */
export function applySandboxGrant(current: HazeSettings, input: {action: 'grant' | 'revoke'; paths: string[]; access?: 'ro' | 'rw'}): SandboxGrantResult {
  const homedir = os.homedir();
  const sandbox: HazeSandboxSettings = current.sandbox ? {...current.sandbox} : {};
  if (input.paths.length === 0) {
    return {action: 'error', message: `Usage: /sandbox ${input.action}${input.action === 'grant' ? ' [--rw]' : ''} <path> [path…] — the path to grant outside the sandbox boundary, ~ expanded.`};
  }
  if (input.action === 'grant') {
    const access = input.access ?? 'ro';
    const listKey = access === 'rw' ? 'rwRoots' : 'roRoots';
    const list = [...(sandbox[listKey] ?? [])];
    const granted: string[] = [];
    for (const raw of input.paths) {
      const expanded = expandRoot(raw, homedir);
      if (isProtectedSecretPath(expanded, homedir) || isProtectedSecretPath(path.resolve(expanded), homedir)) {
        return {action: 'error', message: `Refusing to grant "${raw}": it resolves to a protected secret path (SSH keys, shell histories, .env, credential stores). Secret files can never be granted to the sandbox; grant the specific non-secret directory instead.`};
      }
      if (list.some(existing => expandRoot(existing, homedir) === expanded)) continue;
      list.push(raw);
      granted.push(raw);
    }
    if (granted.length === 0) return {action: 'noop', message: 'Already granted — nothing to add.'};
    sandbox[listKey] = list;
    return {
      action: 'granted',
      sandbox,
      message: `Granted ${access === 'rw' ? 'read-write' : 'read-only'} access${access === 'ro' ? ' (credentials inside the path become readable by sandboxed commands)' : ''}: ${granted.join(', ')}. Saved to sandbox.${listKey} in ~/.haze/settings.json; applies from the next turn. Revoke with /sandbox revoke <path>.`,
    };
  }
  const revoked: string[] = [];
  for (const key of ['roRoots', 'rwRoots'] as const) {
    const list = sandbox[key] ?? [];
    const kept = list.filter(existing => {
      const expanded = expandRoot(existing, homedir);
      const matched = input.paths.some(raw => expandRoot(raw, homedir) === expanded);
      if (matched) revoked.push(existing);
      return !matched;
    });
    if (kept.length > 0) sandbox[key] = kept;
    else delete sandbox[key];
  }
  if (revoked.length === 0) return {action: 'noop', message: 'No matching grant found. /sandbox lists all effective roots.'};
  return {action: 'revoked', sandbox, message: `Revoked: ${revoked.join(', ')}. Applies from the next turn.`};
}

export async function handleSandboxCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  const normalized = args.trim().toLowerCase();
  if (normalized === 'grant' || normalized.startsWith('grant ')) {
    const rest = args.trim().slice('grant'.length).trim();
    const access: 'ro' | 'rw' = rest.startsWith('--rw ') ? 'rw' : 'ro';
    const paths = (access === 'rw' ? rest.slice(4) : rest).split(/\s+/).filter(Boolean);
    const result = applySandboxGrant(ctx.settings, {action: 'grant', paths, access});
    if (result.sandbox) await ctx.updateSettings({sandbox: result.sandbox});
    ctx.addSystemMessage(result.message);
    return 'handled';
  }
  if (normalized === 'revoke' || normalized.startsWith('revoke ')) {
    const paths = args.trim().slice('revoke'.length).trim().split(/\s+/).filter(Boolean);
    const result = applySandboxGrant(ctx.settings, {action: 'revoke', paths});
    if (result.sandbox) await ctx.updateSettings({sandbox: result.sandbox});
    ctx.addSystemMessage(result.message);
    return 'handled';
  }
  const backendInfo = await detectSandboxBackend();
  if (args.trim().toLowerCase() === 'test') {
    ctx.addSystemMessage(await sandboxSelfTest(backendInfo));
    return 'handled';
  }
  const result = await resolveSandboxCommand(args, {
    settings: ctx.settings,
    sessionOverride: ctx.getSandboxOverride?.(),
    backendInfo,
    workspaceRoot: process.cwd(),
    homedir: os.homedir(),
  });
  ctx.addSystemMessage(result.message);
  return 'handled';
}

/** `/sandbox test`: live probes against the current boundary. */
async function sandboxSelfTest(backendInfo: Awaited<ReturnType<typeof detectSandboxBackend>>): Promise<string> {
  if (backendInfo.backend === 'none') {
    return `Sandbox self-test skipped: backend unavailable (${backendInfo.reason ?? 'unknown'}). ${sandboxUnavailableRemedy(backendInfo)}`;
  }
  const {runBoundedProcess} = await import('../../core/process/runBoundedProcess.js');
  const {wrapInvocation, resolveSandboxRuntime} = await import('../../core/sandbox/runner.js');
  const runtime = await resolveSandboxRuntime({workspaceRoot: process.cwd(), backendInfo});
  const run = async (label: string, command: string) => {
    const wrapped = wrapInvocation({command: '/bin/sh', args: ['-c', command]}, runtime);
    if ('unavailable' in wrapped) return `${label}: refused (${wrapped.error})`;
    const result = await runBoundedProcess({...wrapped.invocation, cwd: process.cwd(), timeoutMs: 15_000, maxStdoutBytes: 512, maxStderrBytes: 512});
    return `${label}: ${result.code === 0 ? 'ok' : `blocked (exit ${result.code ?? 'signal'})`}`;
  };
  const results = [
    await run('write inside workspace', 'echo haze-sandbox-probe > .haze-sandbox-selftest && rm .haze-sandbox-selftest'),
    await run('read ~/.ssh (expect blocked)', 'ls ~/.ssh'),
    await run('read ~/.haze/AGENTS.md', 'cat ~/.haze/AGENTS.md'),
  ];
  return [`Sandbox self-test (${backendInfo.backend}):`, ...results.map(line => `  ${line}`)].join('\n');
}
