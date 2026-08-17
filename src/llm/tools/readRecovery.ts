import fs from 'node:fs/promises';
import path from 'node:path';
import type {ToolFailureReasonCode} from '../toolResultTypes.js';
import {resolveWorkspacePath, workspaceRelativePath, workspaceRoot} from '../../utils/path.js';
import {isGitIgnored} from './fileToolShared.js';
import {HazeToolError} from './failures.js';

export interface ReadFailureRecovery {
  reasonCode?: ToolFailureReasonCode;
  suggestedNextStep: string;
  suggestedPaths?: string[];
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error == null || !('code' in error)) return undefined;
  const code = (error as {code?: unknown}).code;
  return typeof code === 'string' ? code : undefined;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({length: right.length + 1}, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

async function existingAncestor(candidate: string, root: string): Promise<string | undefined> {
  let current = path.dirname(candidate);
  while (current === root || current.startsWith(`${root}${path.sep}`)) {
    try {
      if ((await fs.stat(current)).isDirectory()) return current;
    } catch {
      // Continue toward the workspace root.
    }
    if (current === root) break;
    current = path.dirname(current);
  }
  return undefined;
}

/** Return a few close, non-ignored siblings without walking the workspace. */
async function nearbyReadablePaths(filePath: string): Promise<string[]> {
  let candidate: string;
  try {
    candidate = resolveWorkspacePath(filePath);
  } catch {
    return [];
  }
  const root = workspaceRoot();
  const ancestor = await existingAncestor(candidate, root);
  if (!ancestor) return [];
  const remainder = path.relative(ancestor, candidate).split(path.sep).filter(Boolean);
  const wanted = remainder[0] ?? path.basename(candidate);
  let entries: Array<{name: string; isDirectory: () => boolean}>;
  try {
    entries = await fs.readdir(ancestor, {withFileTypes: true});
  } catch {
    return [];
  }
  const ranked = entries
    .filter(entry => entry.name !== '.git')
    .map(entry => ({entry, distance: editDistance(wanted.toLowerCase(), entry.name.toLowerCase())}))
    .filter(({entry, distance}) => distance <= Math.max(2, Math.ceil(wanted.length * 0.4)) || entry.name.toLowerCase().includes(wanted.toLowerCase()) || wanted.toLowerCase().includes(entry.name.toLowerCase()))
    .sort((left, right) => left.distance - right.distance || left.entry.name.localeCompare(right.entry.name))
    .slice(0, 10);
  const suggestions: string[] = [];
  for (const {entry} of ranked) {
    const absolute = path.join(ancestor, entry.name);
    if (await isGitIgnored(absolute)) continue;
    const relative = workspaceRelativePath(absolute).replaceAll(path.sep, '/');
    suggestions.push(entry.isDirectory() ? `${relative}/` : relative);
    if (suggestions.length === 5) break;
  }
  return suggestions;
}

export async function assertReadableTextFile(absolutePath: string, filePath: string): Promise<void> {
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) {
    throw new HazeToolError(`${filePath} is not a regular file.`, 'not_a_file', {recoveryTool: 'listFiles', recoveryInput: {path: filePath}});
  }
  const handle = await fs.open(absolutePath, 'r');
  try {
    const sample = Buffer.alloc(Math.min(8192, stat.size));
    const {bytesRead} = await handle.read(sample, 0, sample.length, 0);
    const bytes = sample.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new HazeToolError(`${filePath} appears to be binary, not UTF-8 text.`, 'binary_file');
    try {
      new TextDecoder('utf-8', {fatal: true}).decode(bytes, {stream: bytesRead < stat.size});
    } catch {
      throw new HazeToolError(`${filePath} is not valid UTF-8 text.`, 'binary_file');
    }
  } finally {
    await handle.close();
  }
}

export async function readFailureRecovery(filePath: string, error: unknown): Promise<ReadFailureRecovery> {
  if (error instanceof HazeToolError) {
    if (error.reasonCode === 'ignored_path') return {reasonCode: error.reasonCode, suggestedNextStep: 'Set allowIgnored=true only when the user explicitly needs this ignored file.'};
    if (error.reasonCode === 'secret_file_protected') return {reasonCode: error.reasonCode, suggestedNextStep: 'Protected secret file: do not retry with other tools, paths, or shell. Ask the user to provide the needed value in the conversation instead.'};
    if (error.reasonCode === 'binary_file') return {reasonCode: error.reasonCode, suggestedNextStep: 'Use an appropriate binary or image inspection tool instead of retrying readFile.'};
    if (error.reasonCode === 'not_a_file') return {reasonCode: error.reasonCode, suggestedNextStep: 'Use listFiles for the directory, then read the intended regular file.'};
    if (error.reasonCode === 'invalid_line_range') return {reasonCode: error.reasonCode, suggestedNextStep: 'Retry with an offset within the reported total line count.'};
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('outside the workspace')) {
    return {reasonCode: 'outside_workspace', suggestedNextStep: 'Use a path inside the workspace, or ask the user to mention the outside path explicitly for read-only access.'};
  }
  const code = errorCode(error);
  if (code === 'ENOENT') {
    const suggestedPaths = await nearbyReadablePaths(filePath);
    const suffix = suggestedPaths.length > 0 ? ` Nearby paths: ${suggestedPaths.join(', ')}.` : '';
    return {
      reasonCode: 'path_not_found',
      suggestedNextStep: `Correct the path using the nearby paths or listFiles; do not guess another path.${suffix}`,
      ...(suggestedPaths.length > 0 ? {suggestedPaths} : {}),
    };
  }
  if (code === 'EISDIR') {
    return {reasonCode: 'not_a_file', suggestedNextStep: 'Use listFiles for this directory, then read the intended file.'};
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return {reasonCode: 'permission_denied', suggestedNextStep: 'Check file permissions or ask the user for access; do not retry unchanged.'};
  }
  return {suggestedNextStep: 'Check the path with listFiles, or set allowIgnored=true only if the user explicitly asked to inspect an ignored file.'};
}
