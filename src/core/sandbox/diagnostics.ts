import fs from 'node:fs/promises';
import type {SandboxBoundary} from './boundary.js';

/**
 * Post-hoc sandbox-denial classification for shell results.
 *
 * Neither backend emits a distinct, reliable denial marker on stderr:
 * Seatbelt fails operations with EPERM ("operation not permitted", plus its
 * own dlopen/execvp markers), and bubblewrap's absent paths surface as
 * ENOENT. Tools then format the errno a dozen different ways, so this
 * classifier walks an ordered list of message-shape families:
 *
 *   macOS marker      '/path' (file system sandbox blocked open())
 *   sandbox-exec      execvp() of '/path' failed: Operation not permitted
 *   python            [Errno 13] Permission denied: '/path'
 *   node/libuv        EPERM: operation not permitted, open '/path'
 *   posix (plain)     cat: /path: Operation not permitted
 *   posix (quoted)    could not open '/path': Permission denied   (git, bash)
 *   zsh               permission denied: /path
 *   java              AccessDeniedException: /path
 *   rust/anyhow       Permission denied (os error 13)             (no path)
 *   network (strict)  Could not resolve host / Connection refused (hosts,
 *                     gated on the strict profile so ordinary internet
 *                     failures are never blamed on the sandbox)
 *
 * ENOENT matches are only boundary-shaped when the path (or its nearest
 * existing ancestor) exists on the host outside the boundary. The classifier
 * must stay conservative: unrelated failures never get sandbox blame, and a
 * path inside the boundary keeps the kind but loses the hint. Verified in
 * both directions by tests.
 */

export interface SandboxDenial {
  kind: 'read' | 'write' | 'exec' | 'network' | 'unknown';
  pathHint?: string;
}

const SCAN_LIMIT = 8_192;

const ERRNO_TEXT = 'operation not permitted|permission denied|read-only file system|no such file or directory';

type ErrnoKind = 'eperm' | 'eacces' | 'erofs' | 'enoent';

function errnoKind(errnoText: string): ErrnoKind {
  if (/read-only file system/i.test(errnoText)) return 'erofs';
  if (/permission denied|accessdenied/i.test(errnoText)) return 'eacces';
  if (/no such file|nosuchfile/i.test(errnoText)) return 'enoent';
  return 'eperm';
}

/** Ordered message-shape families; group 1 is always the path, the errno is inferred from the whole match. */
const EXTRACTORS: RegExp[] = [
  // macOS's own unambiguous seatbelt marker (dlopen and friends).
  new RegExp(`'(/[^'()\\n]+)'\\s*\\(file system sandbox blocked open\\(\\)\\)`, 'gi'),
  // POSIX plain: "cat: /path: Operation not permitted" (shell tools, Go).
  new RegExp(`([^\\s:'"]+): (${ERRNO_TEXT})`, 'gi'),
  // POSIX quoted: "could not open '/path': Permission denied" (git, bash).
  new RegExp(`'(/[^'\\n]+)': (${ERRNO_TEXT})`, 'gi'),
  new RegExp(`"(/[^"\\n]+)": (${ERRNO_TEXT})`, 'gi'),
  // Python: "[Errno 13] Permission denied: '/path'".
  new RegExp(`\\[Errno \\d+\\] (?:${ERRNO_TEXT}): '(/[^'\\n]+)'`, 'gi'),
  // Node/libuv (and Deno/Bun): "EPERM: operation not permitted, open '/path'".
  new RegExp(`\\b(?:EACCES|EPERM|EROFS|ENOENT): [^,\\n]*, [a-zA-Z]+ '(/[^'\\n]+)'`, 'gi'),
  // zsh: "permission denied: /path".
  new RegExp(`permission denied: (/[^:\\s]+)`, 'gi'),
  // Java NIO: "AccessDeniedException: /path".
  new RegExp(`(?:AccessDeniedException|FileSystemException|NoSuchFileException): (/[^:\\s]+)`, 'gi'),
];

function boundaryCovers(boundary: SandboxBoundary, candidate: string): boolean {
  for (const root of boundary.roots) {
    if (candidate === root.realPath || candidate.startsWith(`${root.realPath}/`)) return true;
  }
  return false;
}

function nearestExisting(candidate: string): Promise<string | undefined> {
  let current = candidate;
  return (async () => {
    for (let depth = 0; depth < 16 && current !== '/' && current !== '.'; depth++) {
      try {
        await fs.stat(current);
        return current;
      } catch {
        const parent = current.slice(0, current.lastIndexOf('/')) || '/';
        current = parent;
      }
    }
    return undefined;
  })();
}

/**
 * Infer the operation kind from the failing verb adjacent to the path
 * ("open /x", "mkdir: /x"). Verbless shapes (Python's final line, zsh, Java)
 * default to read: read-only grants also enable exec, and a mistaken guess
 * self-corrects through the --rw hint in the remedy.
 */
function kindFromVerbs(text: string, path: string): SandboxDenial['kind'] {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const write = new RegExp(`\\b(?:create|mkdir|write|append|touch|unlink|remove|rm|rename|move|copy|truncate)[^\\n]{0,32}['"]?${escaped}`);
  return write.test(text) ? 'write' : 'read';
}

const NETWORK_FAILURE = /failed to connect|couldn't connect|could not connect|connection refused|could not resolve|name or service not known|network is unreachable|ENETUNREACH|ECONNREFUSED|EAI_AGAIN/i;

export async function classifySandboxDenial(input: {
  code: number | null;
  stderr: string;
  boundary: SandboxBoundary | undefined;
}): Promise<SandboxDenial | undefined> {
  const {boundary} = input;
  if (!boundary) return undefined;
  const text = input.stderr.slice(0, SCAN_LIMIT);
  if (!text) return undefined;

  // sandbox-exec's own diagnostics: exec failures carry the binary path.
  const execvp = /execvp\(\) of '?([^':\n]+)'? failed: Operation not permitted/i.exec(text);
  if (execvp?.[1] && execvp[1].startsWith('/')) {
    return {kind: 'exec', pathHint: boundaryCovers(boundary, execvp[1]) ? undefined : execvp[1]};
  }
  if (/sandbox-exec:|sandbox profile/i.test(text)) {
    return {kind: 'unknown'};
  }

  // macOS's own unambiguous seatbelt marker: the operation is always an open
  // (dlopen and friends) — the strongest signal the boundary gives.
  const marker = /'([^'()\n]+)'\s*\(file system sandbox blocked open\(\)\)/.exec(text);
  if (marker?.[1] && marker[1].startsWith('/')) {
    return {kind: 'read', pathHint: boundaryCovers(boundary, marker[1]) ? undefined : marker[1]};
  }

  for (const extractor of EXTRACTORS) {
    for (const match of text.matchAll(extractor)) {
      const path = match[1];
      if (!path || !path.startsWith('/')) continue;
      const kind0 = errnoKind(match[0]);
      if (kind0 === 'enoent') {
        const existing = await nearestExisting(path);
        if (existing && !boundaryCovers(boundary, existing)) return {kind: 'read', pathHint: existing};
        continue;
      }
      const kind = kind0 === 'erofs' ? 'write' : kindFromVerbs(text, path);
      return {kind, pathHint: boundaryCovers(boundary, path) ? undefined : path};
    }
  }

  // Hosts are not paths: network denials only exist when the profile denies
  // the network, and matching on connect/resolve failures there is precise
  // (in the workspace profile, an unreachable host is never the sandbox).
  if (boundary.network === 'deny' && NETWORK_FAILURE.test(text)) {
    return {kind: 'network'};
  }

  // Message-less errno (Rust/anyhow): classify the kind, no path available.
  // ENOENT is excluded — a missing path alone is not sandbox evidence.
  if (/operation not permitted|permission denied|accessdenied|read-only file system/i.test(text)) {
    const kind = /read-only file system/i.test(text) ? 'write' : 'unknown';
    return {kind};
  }
  return undefined;
}
