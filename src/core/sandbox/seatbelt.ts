import type {SandboxBoundary, SandboxRoot} from './boundary.js';

/**
 * Seatbelt (macOS) profile generation.
 *
 * `sandbox-exec` execs the target directly, so the sandboxed pid is the
 * command's pid and haze's existing detached process-group teardown keeps
 * working unchanged. The profile travels as one argv entry (`-p`); it is
 * never written to a file.
 *
 * Phase-0 spike findings baked into this generator (specs/os-sandbox):
 * - Seatbelt canonicalizes paths before matching subpath/literal filters, so
 *   every root must be emitted canonically (`/tmp` → `/private/tmp`); the
 *   lexical alias is emitted alongside for defense in depth.
 * - `process-exec` is denied by `(deny default)` too — toolchains under
 *   `/Library/Developer`, nvm `$HOME` trees, and the user shell all need
 *   explicit exec allows.
 * - `os.tmpdir()` must be WRITABLE (xcrun caches) and `/private/var/select`
 *   readable (`/bin/sh` opens it).
 * - Deny literals/subpaths inside allowed subtrees win (verified live):
 *   that is how config-dir credentials are masked.
 */

/** Scheme string escaping for SBPL literals. */
export function sbplString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function subpathFilters(root: SandboxRoot): string[] {
  const filters = [`(subpath "${sbplString(root.realPath)}")`];
  if (root.path !== root.realPath) filters.push(`(subpath "${sbplString(root.path)}")`);
  return filters;
}

const DEV_READ_LITERALS = ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom'];

export function seatbeltProfile(boundary: SandboxBoundary): string {
  const readFilters = boundary.roots.flatMap(subpathFilters);
  const writeRoots = boundary.roots.filter(root => root.access === 'rw');
  const execFilters = boundary.roots.flatMap(root => [(subpathFilters(root)[0])]);

  const lines: string[] = [
    '(version 1)',
    '(import "system.sb")',
    '(deny default)',
    // Toolchains under $HOME (nvm, volta) realpath their entry files, which
    // lstats every ancestor (/Users, /Users/x, /Users/x/.nvm) before reaching
    // the allowed install subtree. Metadata (stat/lstat) everywhere, content
    // nowhere: directory listing still needs file-read-data on the directory
    // itself, which stays denied outside the boundary.
    '(allow file-read-metadata (subpath "/"))',
    `(allow file-read* ${readFilters.join(' ')})`,
    `(allow file-read* ${DEV_READ_LITERALS.map(literal => `(literal "${literal}")`).join(' ')})`,
  ];
  if (writeRoots.length > 0) {
    lines.push(`(allow file-write* ${writeRoots.flatMap(subpathFilters).join(' ')})`);
  }
  lines.push(`(allow process-exec (literal "${sbplString('/bin/sh')}") ${execFilters.join(' ')})`);
  lines.push('(allow process-fork)');
  lines.push('(allow sysctl-read)');
  lines.push(boundary.network === 'deny' ? '(deny network*)' : '(allow network*)');
  // Credential masks come last: denies win over the allow rules above.
  const maskFilters = boundary.masks
    .map(mask => (mask.kind === 'dir' ? `(subpath "${sbplString(mask.path)}")` : `(literal "${sbplString(mask.path)}")`))
    .join(' ');
  if (maskFilters) lines.push(`(deny file-read* ${maskFilters})`);
  return lines.join('\n');
}

export interface SeatbeltInvocation {
  command: '/usr/bin/sandbox-exec';
  args: string[];
}

/**
 * Wrap a spawn target (`shellInvocation` output) in `sandbox-exec`. The
 * original target runs verbatim after `--`; cwd/env/stdio handling stay with
 * the caller (`core/process` primitives are unchanged).
 */
export function seatbeltInvocation(target: {command: string; args: string[]}, boundary: SandboxBoundary): SeatbeltInvocation {
  return {
    command: '/usr/bin/sandbox-exec',
    args: ['-p', seatbeltProfile(boundary), '--', target.command, ...target.args],
  };
}
