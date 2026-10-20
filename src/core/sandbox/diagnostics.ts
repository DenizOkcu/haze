import fs from 'node:fs/promises';
import type {SandboxBoundary} from './boundary.js';

/**
 * Post-hoc sandbox-denial classification for shell results.
 *
 * Neither backend emits a distinct, reliable denial marker on stderr:
 * Seatbelt fails operations with EPERM ("Operation not permitted"), and
 * bubblewrap's absent paths surface as ENOENT. This heuristic therefore only
 * fires when the evidence is boundary-shaped:
 *
 * - EPERM/EROFS-class messages while the sandbox is active, or
 * - "No such file or directory" for a path that exists on the host but sits
 *   outside the boundary (an unmounted path — Linux/bwrap), or
 * - an explicit sandbox refusal string from either backend.
 *
 * It must stay conservative: an unrelated failure (missing binary, syntax
 * error, genuine absent file inside the workspace) never gets sandbox
 * blame. Verified in both directions by tests.
 */

export interface SandboxDenial {
  kind: 'read' | 'write' | 'exec' | 'network' | 'unknown';
  pathHint?: string;
}

const SCAN_LIMIT = 8_192;

// `path: errno` shapes from both shell utilities ("cat: /x: Operation not
// permitted", capital-O errno) and Go/Rust/Python programs ("open /x:
// operation not permitted", lowercase errno) — case-insensitive on purpose.
const PATH_IN_MESSAGE = /([^\s:'"]+[^\s:'"]*): (operation not permitted|read-only file system|permission denied|no such file or directory)/gi;

function boundaryCovers(boundary: SandboxBoundary, candidate: string): boolean {
  for (const root of boundary.roots) {
    if (candidate === root.realPath || candidate.startsWith(`${root.realPath}/`)) return true;
  }
  return false;
}

function kindFromMessage(message: string): SandboxDenial['kind'] {
  if (/read-only file system/i.test(message)) return 'write';
  if (/network|socket|connection refused|could not resolve/i.test(message)) return 'network';
  if (/exec|spawn|cannot execute|not executable/i.test(message)) return 'exec';
  return 'unknown';
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

export async function classifySandboxDenial(input: {
  code: number | null;
  stderr: string;
  boundary: SandboxBoundary | undefined;
}): Promise<SandboxDenial | undefined> {
  const {boundary} = input;
  if (!boundary) return undefined;
  const text = input.stderr.slice(0, SCAN_LIMIT);
  if (!text) return undefined;
  if (/sandbox-exec:|sandbox profile/i.test(text)) {
    return {kind: 'unknown', pathHint: undefined};
  }

  const matches = [...text.matchAll(PATH_IN_MESSAGE)];
  for (const match of matches) {
    const rawPath = match[1];
    if (!rawPath || !rawPath.startsWith('/')) continue;
    const message = match[0];
    if (/no such file or directory/i.test(message)) {
      // ENOENT is sandbox-shaped only when the path (or its nearest existing
      // ancestor) exists on the host but is outside the boundary.
      const existing = await nearestExisting(rawPath);
      if (existing && !boundaryCovers(boundary, existing)) return {kind: 'read', pathHint: existing};
      continue;
    }
    if (/operation not permitted|read-only file system|permission denied/i.test(message)) {
      let kind = kindFromMessage(message);
      if (kind === 'unknown') {
        // Go/Rust/Python print the failing verb before the path ("open /x:
        // operation not permitted"); the captured match only holds
        // "path: errno", so infer reads from the surrounding line.
        const escaped = rawPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b(?:open|stat|read|readfile|readfileasync)\\b[^\\n]*${escaped}`, 'i').test(text)) kind = 'read';
      }
      return {kind, pathHint: boundaryCovers(boundary, rawPath) ? undefined : rawPath};
    }
  }

  // Message without a parseable "path: errno" shape (e.g. python's OSError).
  if (/operation not permitted|read-only file system/i.test(text)) {
    return {kind: /read-only file system/i.test(text) ? 'write' : 'unknown'};
  }
  return undefined;
}
