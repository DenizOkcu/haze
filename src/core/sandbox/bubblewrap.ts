import path from 'node:path';
import type {SandboxBoundary} from './boundary.js';

/**
 * bubblewrap (Linux) argv generation.
 *
 * bwrap builds an explicit mount tree: paths that are not bind-mounted do not
 * exist inside the sandbox, so default-deny comes from absence. Mounts apply
 * in argv order, which this generator exploits:
 *
 * 1. `--tmpfs $HOME` gives commands an empty writable home (npm, dotfiles)
 *    without exposing `~/.ssh` and friends;
 * 2. config dirs, the gitconfig file, and nvm/volta toolchain trees are
 *    re-mounted read-only ON TOP of that tmpfs;
 * 3. credential files inside the mounted config dirs are masked with
 *    `--ro-bind /dev/null <path>` AFTER their owning directory bind, and
 *    transcript directories with `--tmpfs <dir>`.
 *
 * v1 deliberately shares the host PID namespace: haze's process-group
 * teardown (`signalProcessTree`) keeps its exact semantics, and
 * `--die-with-parent` covers grandchild leaks.
 */

export interface PosixIds {
  uid: number;
  gid: number;
}

/** Fixed prologue + system mounts; ordering before any boundary-derived bind. */
function systemArgs(boundary: SandboxBoundary, homeMounted: boolean): string[] {
  const args = [
    '--unshare-user',
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
  ];
  if (boundary.network === 'deny') args.push('--unshare-net');
  args.push(
    '--ro-bind', '/usr', '/usr',
    '--ro-bind-try', '/bin', '/bin',
    '--ro-bind-try', '/sbin', '/sbin',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind-try', '/etc', '/etc',
    '--ro-bind-try', '/opt', '/opt',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/dev/shm',
  );
  if (homeMounted) args.push('--tmpfs', boundary.homedir);
  return args;
}

export function bubblewrapArgs(boundary: SandboxBoundary, ids: PosixIds): string[] {
  const home = boundary.homedir;
  const homeMounted = boundary.platform === 'linux' && home.startsWith('/');
  const args = ['--uid', String(ids.uid), '--gid', String(ids.gid), ...systemArgs(boundary, homeMounted)];

  // Temp: per-command ephemeral /tmp unless the real TMPDIR points elsewhere.
  args.push('--tmpfs', '/tmp');
  const tmpdir = boundary.roots.find(root => root.origin === 'temp' && root.path !== '/tmp' && root.path !== '/private/tmp');
  if (tmpdir) args.push('--bind', tmpdir.realPath, tmpdir.realPath);

  // Boundary binds, in deterministic order. Workspace uses the hard variant
  // (it must exist); everything user/config-shaped uses -try so a vanished
  // path degrades instead of failing every command.
  for (const root of boundary.roots) {
    if (root.origin === 'system' || root.origin === 'temp') continue; // handled by the fixed prologue
    if (root.realPath === '/' || root.realPath === '/tmp' || root.realPath === '/dev' || root.realPath === '/proc') continue;
    if (homeMounted && root.realPath === home) continue; // rw home = the tmpfs itself
    const flag = root.access === 'rw' ? (root.origin === 'workspace' ? '--bind' : '--bind-try') : (root.origin === 'config' || root.origin === 'runtime' || root.origin === 'blessed' || root.origin === 'settings' ? '--ro-bind-try' : '--ro-bind');
    args.push(flag, root.realPath, root.realPath);
  }

  // Masks after their owning dir binds (see module doc).
  for (const mask of boundary.masks) {
    if (mask.kind === 'dir') args.push('--tmpfs', mask.path);
    else args.push('--ro-bind', '/dev/null', mask.path);
  }

  args.push('--chdir', path.resolve(boundary.workspaceRoot));
  return args;
}

export function bubblewrapInvocation(target: {command: string; args: string[]}, boundary: SandboxBoundary, ids: PosixIds): {command: 'bwrap'; args: string[]} {
  return {command: 'bwrap', args: [...bubblewrapArgs(boundary, ids), '--', target.command, ...target.args]};
}
