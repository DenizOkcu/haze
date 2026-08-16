// Shells that accept `-l` (login shell) alongside `-c`. Flags are passed
// separately (`-l -c`, not `-lc`) because that form is accepted by every
// login-capable shell including fish.
const LOGIN_CAPABLE = new Set(['bash', 'zsh', 'ksh', 'ksh93', 'mksh', 'yash', 'fish']);

/**
 * The shell commands run in: the user's login shell from the environment, with
 * a bash fallback. On Windows the fallback stays `bash` (via WSL or Git Bash)
 * because commands are written in POSIX syntax; Git Bash terminals export
 * `SHELL` anyway, so the fallback only covers the no-`SHELL` case.
 */
export function resolveUserShell(): string {
  const fromEnv = process.env.SHELL;
  if (fromEnv) return fromEnv;
  return process.platform === 'win32' ? 'bash' : '/bin/bash';
}

/** Spawn target for running `command` under `shellPath` (default: user's shell). */
export function shellInvocation(command: string, shellPath = resolveUserShell()): {command: string; args: string[]} {
  // Separator-agnostic basename so Windows-style paths resolve on any platform.
  const base = shellPath.split(/[\\/]/).pop() ?? shellPath;
  const name = base.replace(/\.exe$/i, '').toLowerCase();
  if (name === 'pwsh' || name === 'powershell') return {command: shellPath, args: ['-Command', command]};
  if (name === 'cmd') return {command: shellPath, args: ['/c', command]};
  const login = LOGIN_CAPABLE.has(name) ? ['-l'] : [];
  return {command: shellPath, args: [...login, '-c', command]};
}
