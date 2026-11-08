import {existsSync} from 'node:fs';
import path from 'node:path';

// Shells that accept `-l` (login shell) alongside `-c`. Flags are passed
// separately (`-l -c`, not `-lc`) because that form is accepted by every
// login-capable shell including fish.
const LOGIN_CAPABLE = new Set(['bash', 'zsh', 'ksh', 'ksh93', 'mksh', 'yash', 'fish']);

// On Windows, the fallback probes PATH in this order: PowerShell 7 first
// (native, cross-platform), then Git Bash (keeps POSIX workflows), and
// finally cmd.exe via ComSpec.
const WINDOWS_SHELL_PREFERENCE = ['pwsh', 'bash'] as const;

export type ShellDialect = 'posix' | 'fish' | 'csh' | 'powershell' | 'cmd' | 'unknown';

function shellName(shellPath: string) {
  const base = shellPath.split(/[\\/]/).pop() ?? shellPath;
  return base.replace(/\.exe$/i, '').toLowerCase();
}

export function shellDialect(shellPath = resolveUserShell()): ShellDialect {
  const name = shellName(shellPath);
  if (['bash', 'zsh', 'sh', 'dash', 'ksh', 'ksh93', 'mksh', 'yash'].includes(name)) return 'posix';
  if (name === 'fish') return 'fish';
  if (name === 'csh' || name === 'tcsh') return 'csh';
  if (name === 'pwsh' || name === 'powershell') return 'powershell';
  if (name === 'cmd') return 'cmd';
  return 'unknown';
}

/** Model-facing syntax guidance for the selected shell. */
export function shellSyntaxGuidance(shellPath = resolveUserShell()) {
  const dialect = shellDialect(shellPath);
  if (dialect === 'posix') return 'Use POSIX-compatible shell syntax.';
  if (dialect === 'fish') return 'Use fish syntax; do not use POSIX variable-assignment syntax.';
  if (dialect === 'csh') return 'Use csh/tcsh syntax; do not use POSIX variable-assignment syntax.';
  if (dialect === 'powershell') return 'Use PowerShell syntax, cmdlets, quoting, and environment-variable notation.';
  if (dialect === 'cmd') return 'Use Windows cmd.exe syntax and environment-variable notation.';
  return 'Use syntax supported by this shell; avoid shell-specific constructs when uncertain.';
}

export interface ResolveUserShellOptions {
  /** @internal testing seam. */
  platform?: NodeJS.Platform;
  /** @internal testing seam. */
  env?: NodeJS.ProcessEnv;
  /** @internal testing seam. */
  pathExists?: (candidate: string) => boolean;
}

function defaultPathExists(candidate: string): boolean {
  try {
    return existsSync(candidate);
  } catch {
    return false;
  }
}

/** First `name` found on PATH, trying PATHEXT extensions on Windows. Forward slashes join candidates so the lookup also works under a POSIX-host test seam. */
function findOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, pathExists: (candidate: string) => boolean): string | undefined {
  const pathEnv = env.PATH ?? '';
  if (!pathEnv) return undefined;
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  const extensions = platform === 'win32'
    ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').flatMap(ext => [ext, ext.toLowerCase()])]
    : [''];
  const seen = new Set<string>();
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = `${dir}/${name}${ext}`;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (pathExists(candidate)) return candidate;
    }
  }
  return undefined;
}

function detectWindowsShell(options: ResolveUserShellOptions): string {
  const env = options.env ?? process.env;
  const pathExists = options.pathExists ?? defaultPathExists;
  for (const name of WINDOWS_SHELL_PREFERENCE) {
    const found = findOnPath(name, env, 'win32', pathExists);
    if (found) return found;
  }
  return env.ComSpec || 'cmd.exe';
}

/**
 * The shell commands run in: an explicit HAZE_SHELL override, otherwise the
 * user's login shell from the environment. Without either, POSIX falls back
 * to /bin/bash; Windows probes PATH for pwsh, then Git Bash's bash, then
 * cmd.exe via ComSpec. Git Bash terminals export `SHELL` anyway, so the PATH
 * probe only covers terminals that do not.
 */
export function resolveUserShell(options: ResolveUserShellOptions = {}): string {
  const env = options.env ?? process.env;
  const fromEnv = env.HAZE_SHELL || env.SHELL;
  if (fromEnv) return fromEnv;
  if ((options.platform ?? process.platform) === 'win32') return detectWindowsShell(options);
  return '/bin/bash';
}

/** Spawn target for running `command` under `shellPath` (default: user's shell). */
export function shellInvocation(command: string, shellPath = resolveUserShell()): {command: string; args: string[]} {
  const name = shellName(shellPath);
  if (name === 'pwsh' || name === 'powershell') return {command: shellPath, args: ['-Command', command]};
  if (name === 'cmd') return {command: shellPath, args: ['/c', command]};
  const login = LOGIN_CAPABLE.has(name) ? ['-l'] : [];
  return {command: shellPath, args: [...login, '-c', command]};
}
