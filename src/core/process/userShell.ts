// Shells that accept `-l` (login shell) alongside `-c`. Flags are passed
// separately (`-l -c`, not `-lc`) because that form is accepted by every
// login-capable shell including fish.
const LOGIN_CAPABLE = new Set(['bash', 'zsh', 'ksh', 'ksh93', 'mksh', 'yash', 'fish']);

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

/**
 * The shell commands run in: an explicit HAZE_SHELL override, otherwise the
 * user's login shell from the environment, with a bash fallback. On Windows the fallback stays `bash` (via WSL or Git Bash)
 * because commands are written in POSIX syntax; Git Bash terminals export
 * `SHELL` anyway, so the fallback only covers the no-`SHELL` case.
 */
export function resolveUserShell(): string {
  const fromEnv = process.env.HAZE_SHELL || process.env.SHELL;
  if (fromEnv) return fromEnv;
  return process.platform === 'win32' ? 'bash' : '/bin/bash';
}

/** Spawn target for running `command` under `shellPath` (default: user's shell). */
export function shellInvocation(command: string, shellPath = resolveUserShell()): {command: string; args: string[]} {
  const name = shellName(shellPath);
  if (name === 'pwsh' || name === 'powershell') return {command: shellPath, args: ['-Command', command]};
  if (name === 'cmd') return {command: shellPath, args: ['/c', command]};
  const login = LOGIN_CAPABLE.has(name) ? ['-l'] : [];
  return {command: shellPath, args: [...login, '-c', command]};
}
