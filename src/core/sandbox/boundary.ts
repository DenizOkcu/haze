import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {isProtectedSecretPath} from '../safety/secretPaths.js';

/**
 * OS-level sandbox boundary computation (seatbelt on macOS, bubblewrap on
 * Linux — see `seatbelt.ts` / `bubblewrap.ts` for the backend generators).
 *
 * The boundary answers one question: which absolute paths may model-initiated
 * child processes read and write? Everything not in the boundary is denied
 * (seatbelt) or absent (bwrap). Roots come only from user intent:
 *
 * - the workspace the user launched haze in (`process.cwd()`),
 * - temp/cache locations needed by dev tooling,
 * - the `~/.haze` / `~/.claude` config dirs (read-only, credentials masked),
 * - system tool directories (read-only),
 * - paths the user blessed this turn by typing `@path` / a bare slash path
 *   (`core/attachments/readBlessings.ts` — read-only, like the file-tool
 *   bless exception),
 * - explicitly configured `sandbox.roRoots` / `sandbox.rwRoots`.
 *
 * The model can never grow its own boundary: tool inputs are not an input
 * here. Protected-secret paths are dropped even when blessed or configured
 * (mirroring the file-tool rule that secret protection wins over the bless
 * set); credential files inside the mounted config dirs are additionally
 * masked so provider API keys never reach sandboxed stdout.
 *
 * Pure policy module: all platform facts arrive via `SandboxRuntimeFacts`
 * (defaulted from the live process for production callers, injectable in
 * tests). The only filesystem access is the canonicalization pass, which
 * falls back to the lexical path when a root does not exist.
 */

export type SandboxBackend = 'seatbelt' | 'bubblewrap' | 'none';
export type SandboxProfileName = 'workspace' | 'strict';
export type SandboxAccess = 'rw' | 'ro';
export type SandboxRootOrigin = 'workspace' | 'temp' | 'cache' | 'config' | 'runtime' | 'system' | 'blessed' | 'settings';

export interface SandboxRoot {
  /** Path as configured/observed (lexical). */
  path: string;
  /** Canonical real path; equals `path` when the root does not exist. */
  realPath: string;
  access: SandboxAccess;
  origin: SandboxRootOrigin;
}

export interface SandboxMask {
  /** Canonical path made unreadable (file) or empty (directory) inside the sandbox. */
  path: string;
  kind: 'file' | 'dir';
  reason: string;
}

export interface SandboxBoundary {
  workspaceRoot: string;
  profile: SandboxProfileName;
  roots: readonly SandboxRoot[];
  masks: readonly SandboxMask[];
  network: 'allow' | 'deny';
  platform: NodeJS.Platform;
  homedir: string;
}

export interface SandboxRuntimeFacts {
  platform: NodeJS.Platform;
  homedir: string;
  tmpdir: string;
  shellPath: string;
  nodeExecPath: string;
  hazeDir: string;
  claudeDir: string;
  /** Directories on the user's $PATH (login-environment toolchains become read-only roots generically). */
  pathDirs?: readonly string[];
}

/** The `sandbox` settings block shape (validated upstream in `config/settings.ts`). */
export interface SandboxSettingsInput {
  mode?: 'auto' | 'on' | 'off';
  profile?: 'workspace' | 'strict';
  roRoots?: string[];
  rwRoots?: string[];
}

export interface BlessedPathLike {
  realPath: string;
  isDirectory: boolean;
}

/** Live platform facts; the seam tests override. */
export function defaultSandboxRuntimeFacts(): SandboxRuntimeFacts {
  const homedir = os.homedir();
  return {
    platform: process.platform,
    homedir,
    tmpdir: os.tmpdir(),
    shellPath: process.env.SHELL || '/bin/sh',
    nodeExecPath: process.execPath,
    hazeDir: path.join(homedir, '.haze'),
    claudeDir: path.join(homedir, '.claude'),
    pathDirs: (process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
  };
}

/** Read-only system roots dev tooling needs (login shells, toolchains, git). */
export function systemReadRoots(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return [
      '/bin', '/sbin', '/usr/bin', '/usr/lib', '/usr/libexec', '/usr/share', '/usr/local',
      '/opt', '/System', '/Library', '/Applications',
      '/etc', '/private/etc', '/private/var/db', '/private/var/select',
    ];
  }
  if (platform === 'linux') {
    return ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt'];
  }
  return [];
}

/**
 * Credential/transcript files inside the mounted config dirs. Mounting
 * `~/.haze` and `~/.claude` is this feature's choice, so their secrets are
 * masked: files become empty (`/dev/null` bind / read deny) and directories
 * become empty (tmpfs / subpath deny). Workspace-internal secret files are
 * deliberately NOT masked here — `source .env` in a sandboxed shell is a
 * legitimate workflow and the file-tool/prompt layers already handle secrets.
 */
export function configDirMasks(runtime: Pick<SandboxRuntimeFacts, 'hazeDir' | 'claudeDir'>): SandboxMask[] {
  return [
    {path: path.join(runtime.hazeDir, 'settings.json'), kind: 'file', reason: 'provider API keys'},
    {path: path.join(runtime.hazeDir, 'settings.local.json'), kind: 'file', reason: 'provider API keys'},
    {path: path.join(runtime.hazeDir, 'sessions'), kind: 'dir', reason: 'session transcripts'},
    {path: path.join(runtime.hazeDir, 'logs'), kind: 'dir', reason: 'debug logs'},
    {path: path.join(runtime.hazeDir, 'history'), kind: 'dir', reason: 'input history'},
    {path: path.join(runtime.claudeDir, '.credentials.json'), kind: 'file', reason: 'OAuth credentials'},
    {path: path.join(runtime.claudeDir, 'settings.json'), kind: 'file', reason: 'agent settings'},
    {path: path.join(runtime.claudeDir, 'settings.local.json'), kind: 'file', reason: 'agent settings'},
    {path: path.join(runtime.claudeDir, 'projects'), kind: 'dir', reason: 'session transcripts'},
  ];
}

async function canonicalize(candidate: string): Promise<string> {
  const resolved = path.resolve(candidate);
  try {
    return await fs.realpath(resolved);
  } catch {
    // Not on disk (yet): canonicalize the nearest existing ancestor and
    // reattach the remaining segments, so seatbelt subpath/literal filters
    // still match canonically (/tmp/x → /private/tmp/x) for future files.
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    return path.join(await canonicalize(parent), path.basename(resolved));
  }
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.stat(candidate);
    return true;
  } catch {
    return false;
  }
}

function expandTilde(candidate: string, homedir: string): string {
  if (candidate === '~') return homedir;
  if (candidate.startsWith('~/')) return path.join(homedir, candidate.slice(2));
  return path.resolve(candidate);
}

function covers(ancestor: string, child: string): boolean {
  return child === ancestor || child.startsWith(`${ancestor}${path.sep}`);
}

/** Origin weight for deterministic root ordering (snapshots depend on it). */
const ORIGIN_ORDER: SandboxRootOrigin[] = ['workspace', 'temp', 'cache', 'config', 'runtime', 'system', 'blessed', 'settings'];

export async function buildSandboxBoundary(input: {
  workspaceRoot: string;
  blessedPaths?: readonly BlessedPathLike[];
  settings?: SandboxSettingsInput;
  runtime: SandboxRuntimeFacts;
  /** Helper executables the tools spawn directly (e.g. the bundled ripgrep); their directories become read-only runtime roots. */
  helperExecutables?: readonly string[];
}): Promise<SandboxBoundary> {
  const {runtime} = input;
  const settings = input.settings ?? {};
  const profile: SandboxProfileName = settings.profile === 'strict' ? 'strict' : 'workspace';

  type Pending = {path: string; access: SandboxAccess; origin: SandboxRootOrigin};
  const pending: Pending[] = [];

  pending.push({path: input.workspaceRoot, access: 'rw', origin: 'workspace'});
  pending.push({path: runtime.tmpdir, access: 'rw', origin: 'temp'});
  if (runtime.platform === 'darwin') pending.push({path: '/private/tmp', access: 'rw', origin: 'temp'});
  if (profile === 'workspace') {
    // Non-secret by convention; needed for realistic builds (npm/electron/pip).
    if (runtime.platform === 'darwin') {
      pending.push({path: path.join(runtime.homedir, 'Library', 'Caches'), access: 'rw', origin: 'cache'});
      pending.push({path: path.join(runtime.homedir, '.npm'), access: 'rw', origin: 'cache'});
    }
    if (runtime.platform === 'linux') {
      pending.push({path: path.join(runtime.homedir, '.cache'), access: 'rw', origin: 'cache'});
      pending.push({path: path.join(runtime.homedir, '.npm'), access: 'rw', origin: 'cache'});
    }
  }

  pending.push({path: runtime.hazeDir, access: 'ro', origin: 'config'});
  pending.push({path: runtime.claudeDir, access: 'ro', origin: 'config'});
  const gitconfig = path.join(runtime.homedir, '.gitconfig');
  if (await exists(gitconfig)) pending.push({path: gitconfig, access: 'ro', origin: 'config'});

  // Node and shell installs frequently live under $HOME (nvm, volta, custom
  // prefixes); toolchains must stay executable and readable inside the sandbox.
  const nodeBinDir = path.dirname(runtime.nodeExecPath);
  const nodeInstallDir = path.dirname(nodeBinDir);
  pending.push({path: nodeBinDir, access: 'ro', origin: 'runtime'});
  pending.push({path: nodeInstallDir, access: 'ro', origin: 'runtime'});
  const shellDir = path.dirname(runtime.shellPath);
  if (!['/bin', '/usr/bin', '/sbin', '/usr/sbin'].includes(shellDir)) pending.push({path: shellDir, access: 'ro', origin: 'runtime'});
  // Bundled helpers (ripgrep under haze's own node_modules) live outside the
  // workspace when the CLI runs from an installed/global location; their
  // directories must stay executable and readable.
  for (const helper of input.helperExecutables ?? []) {
    if (await exists(helper)) pending.push({path: path.dirname(helper), access: 'ro', origin: 'runtime'});
  }
  // The user's $PATH is their declared toolchain environment — environment-
  // derived, program-agnostic: every existing PATH directory (and its parent
  // when it is a bin/sbin subtree, which is how nvm/volta/cargo/sdkman layout
  // their libexec/share trees) becomes read-only. Nothing here knows about
  // specific tools; the login shell's environment is the source of truth.
  for (const dir of runtime.pathDirs ?? []) {
    if (!await exists(dir)) continue;
    pending.push({path: dir, access: 'ro', origin: 'runtime'});
    const base = path.basename(path.resolve(dir));
    if (base === 'bin' || base === 'sbin') {
      const parent = path.dirname(path.resolve(dir));
      if (parent !== path.parse(parent).root) pending.push({path: parent, access: 'ro', origin: 'runtime'});
    }
  }

  for (const root of systemReadRoots(runtime.platform)) pending.push({path: root, access: 'ro', origin: 'system'});

  for (const blessed of input.blessedPaths ?? []) {
    // Secret protection wins over the bless set, exactly like the file tools.
    if (isProtectedSecretPath(blessed.realPath, runtime.homedir)) continue;
    pending.push({path: blessed.realPath, access: 'ro', origin: 'blessed'});
  }

  for (const root of settings.roRoots ?? []) {
    const expanded = expandTilde(root, runtime.homedir);
    if (isProtectedSecretPath(expanded, runtime.homedir)) continue; // settings validation already failed loudly; runtime backstop
    pending.push({path: expanded, access: 'ro', origin: 'settings'});
  }
  for (const root of settings.rwRoots ?? []) {
    const expanded = expandTilde(root, runtime.homedir);
    if (isProtectedSecretPath(expanded, runtime.homedir)) continue;
    pending.push({path: expanded, access: 'rw', origin: 'settings'});
  }

  // Canonicalize, then dedupe: an rw root absorbs covered roots; an ro root
  // under any same-or-weaker root is dropped; rw always wins collisions.
  const byReal = new Map<string, SandboxRoot>();
  for (const entry of pending) {
    const realPath = await canonicalize(entry.path);
    const existing = byReal.get(realPath);
    if (existing) {
      if (entry.access === 'rw' && existing.access === 'ro') byReal.set(realPath, {...existing, access: 'rw'});
      continue;
    }
    byReal.set(realPath, {path: entry.path, realPath, access: entry.access, origin: entry.origin});
  }
  const canonicalRoots = [...byReal.values()].filter(root => {
    for (const other of byReal.values()) {
      if (other === root || !covers(other.realPath, root.realPath)) continue;
      if (other.access === 'rw') return false; // rw ancestor absorbs everything beneath
      if (other.access === 'ro' && root.access === 'ro') return false; // ro under ro
    }
    return true;
  });
  canonicalRoots.sort((a, b) => {
    const originDelta = ORIGIN_ORDER.indexOf(a.origin) - ORIGIN_ORDER.indexOf(b.origin);
    return originDelta !== 0 ? originDelta : a.realPath.localeCompare(b.realPath);
  });

  const configDirs = new Set([await canonicalize(runtime.hazeDir), await canonicalize(runtime.claudeDir)]);
  const masks: SandboxMask[] = [];
  for (const mask of configDirMasks(runtime)) {
    // Only mask inside config dirs that actually exist (a missing ~/.claude
    // is not mounted, so its masks would be noise).
    const parent = path.dirname(mask.path);
    if (!await exists(parent) || !configDirs.has(await canonicalize(parent))) continue;
    masks.push({...mask, path: await canonicalize(mask.path)});
  }

  return {
    workspaceRoot: await canonicalize(input.workspaceRoot),
    profile,
    roots: canonicalRoots,
    masks,
    network: profile === 'strict' ? 'deny' : 'allow',
    platform: runtime.platform,
    homedir: runtime.homedir,
  };
}
