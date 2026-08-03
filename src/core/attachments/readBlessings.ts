import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {extractPathMentions, IMAGE_MEDIA_TYPES} from './imageAttachments.js';
import {workspaceRoot} from '../../utils/path.js';

/**
 * Read-blessings for paths the user mentioned in the prompt (F03 follow-on).
 *
 * When the user types `@path` or a bare path containing `/`, the model is
 * allowed to `readFile` / `grep` it even outside `process.cwd()`. This module
 * resolves those mentions into a deduped list of blessed real paths. The
 * read-tooling layer consults `isPathBlessed` to skip workspace confinement
 * for them. Mutating tools never consult this set.
 *
 * Like image attachments: an `@` mention is an explicit user-typed reference,
 * so host paths are allowed. Unlike image attachments: text paths stay in the
 * prompt text (the model needs the cue to know what to read).
 */

export interface BlessedPath {
  /** Canonical real path (post-symlink-resolution). */
  realPath: string;
  /** Whether the blessed path is a directory; directories bless the whole tree. */
  isDirectory: boolean;
}

export interface ResolvedReadBlessings {
  blessedPaths: BlessedPath[];
}

function resolveAttachmentPath(token: string): string {
  if (token === '~' || token.startsWith('~/')) return path.join(os.homedir(), token.slice(1));
  return path.resolve(workspaceRoot(), token);
}

async function statFile(absolutePath: string): Promise<import('node:fs').Stats | undefined> {
  try {
    return await fs.stat(absolutePath);
  } catch {
    return undefined;
  }
}

/**
 * Resolve `@path` and bare-path mentions into read-blessings.
 *
 * - Image-extension paths are skipped — `resolveImageAttachments` owns them.
 * - Mentions that do not resolve to an existing file or directory are skipped.
 * - The real path dedupes aliases (symlinks, `..` segments).
 * - Mentions are NOT stripped from the prompt text: the model needs them as a
 *   cue to know what to read.
 */
export async function resolveReadBlessings(text: string): Promise<ResolvedReadBlessings> {
  const mentions = extractPathMentions(text);
  if (mentions.length === 0) return {blessedPaths: []};

  const blessedPaths: BlessedPath[] = [];
  const seenRealPaths = new Set<string>();

  for (const {token} of mentions) {
    // Backslash escapes are removed for filesystem resolution (same rule as
    // image attachments). See imageAttachments.ts for the rationale.
    const resolveToken = token.replace(/\\(.)/g, '$1');
    // Image-extension paths are owned by the image attachment system; skip
    // them here so an attached image is not also blessed for read.
    if (IMAGE_MEDIA_TYPES[path.extname(resolveToken).toLowerCase()]) continue;

    // Sentence-ending period is not part of the filename — same fallback as
    // for image attachments.
    let absolutePath = resolveAttachmentPath(resolveToken);
    let stats = await statFile(absolutePath);
    if (!stats) {
      const trimmed = resolveToken.replace(/\.+$/, '');
      if (trimmed && trimmed !== resolveToken) {
        const trimmedPath = resolveAttachmentPath(trimmed);
        const trimmedStats = await statFile(trimmedPath);
        if (trimmedStats) {
          absolutePath = trimmedPath;
          stats = trimmedStats;
        }
      }
    }
    if (!stats) continue;

    const realPath = await fs.realpath(absolutePath);
    if (seenRealPaths.has(realPath)) continue;
    seenRealPaths.add(realPath);
    blessedPaths.push({realPath, isDirectory: stats.isDirectory()});
  }

  return {blessedPaths};
}

/**
 * Whether a requested real path may be read outside workspace confinement.
 * True if the path is itself blessed, or falls inside a blessed directory.
 */
export function isPathBlessed(requestedRealPath: string, blessed: readonly BlessedPath[]): boolean {
  for (const entry of blessed) {
    if (entry.realPath === requestedRealPath) return true;
    if (entry.isDirectory && requestedRealPath.startsWith(`${entry.realPath}${path.sep}`)) return true;
  }
  return false;
}
