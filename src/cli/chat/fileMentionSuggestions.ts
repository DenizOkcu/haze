import fs from 'node:fs/promises';
import path from 'node:path';
import {walkDir} from '../../utils/fs.js';
import {createIgnoreClassifier} from '../../llm/tools/gitIgnore.js';
import {workspaceRoot} from '../../utils/path.js';
import type {TextInputSuggestion} from '../../ui/components/TextInput.js';

/**
 * Tab-completion support for `@`-mention paths (F04 AC1).
 *
 * Mention completion is cursor-aware partial replacement — unlike slash
 * commands, the suggestion replaces only the `@token` at the cursor, not the
 * whole input. Detection runs in the TextInput layer; this module owns the
 * filesystem listing (bounded, `.gitignore`-aware) and stays UI-agnostic.
 */

/** Cap so completion stays responsive in large repos (F04 AC5). */
const MAX_MENTION_SUGGESTIONS = 20;

/** Characters allowed inside a `@token` while it is being typed. */
const MENTION_TOKEN_PATTERN = /@[\w./~-]*/g;

export interface MentionContext {
  /** Full token including the leading `@`. */
  token: string;
  /** Index in the source string where the `@` sits. */
  start: number;
  /** Index one past the last char of the token. */
  end: number;
}

/**
 * Find the `@token` (if any) at the given cursor position. The cursor may
 * sit anywhere inside the token or directly after its last char — both
 * count as "inside" so the user can keep typing or completing.
 */
export function detectMentionAtCursor(value: string, cursor: number): MentionContext | undefined {
  for (const match of value.matchAll(MENTION_TOKEN_PATTERN)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (cursor >= start && cursor <= end) return {token: match[0], start, end};
  }
  return undefined;
}

/**
 * Strip the leading `@` and split the query into parent directory + prefix.
 * `@src/f` → `{parentDir: 'src', prefix: 'f'}`; `@` → `{parentDir: '.', prefix: ''}`.
 */
function splitQuery(token: string): {parentDir: string; prefix: string} {
  const query = token.replace(/^@/, '');
  const lastSlash = query.lastIndexOf('/');
  if (lastSlash < 0) return {parentDir: '.', prefix: query};
  return {parentDir: query.slice(0, lastSlash), prefix: query.slice(lastSlash + 1)};
}

export interface FileMentionSuggestionsOptions {
  /** Override the workspace root for tests. Defaults to `process.cwd()`. */
  workspaceRoot?: string;
}

/**
 * List workspace paths matching the `@token` for tab completion. The token is
 * treated as `@<parent>/<prefix>`; the parent directory is listed (one level,
 * non-recursive) and children are filtered by the prefix. `.gitignored` paths
 * are excluded; `.git` and `node_modules` are skipped by `walkDir` itself.
 *
 * Suggestion values include the leading `@` so the caller can replace the
 * `@token` range verbatim with the chosen suggestion.
 */
export async function fileMentionSuggestions(
  token: string,
  options: FileMentionSuggestionsOptions = {},
): Promise<TextInputSuggestion[]> {
  const root = options.workspaceRoot ?? workspaceRoot();
  const {parentDir, prefix} = splitQuery(token);
  const absoluteParent = path.resolve(root, parentDir);
  // Keep completion inside the workspace — outside paths get the read-blessing
  // surface but not tab completion (the spec confines completion to workspace).
  const relative = path.relative(root, absoluteParent);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return [];

  // Reject non-directory parents (e.g. `@file.txt/`) before walkDir would
  // throw ENOTDIR on readdir.
  let parentStats: import('node:fs').Stats;
  try {
    parentStats = await fs.stat(absoluteParent);
  } catch {
    return [];
  }
  if (!parentStats.isDirectory()) return [];

  const classifier = createIgnoreClassifier(root);
  const entries = await walkDir(absoluteParent, {
    recursive: false,
    maxEntries: MAX_MENTION_SUGGESTIONS * 4,
    ignoreBatch: entries => classifier.classify(entries),
  });

  const matches = entries
    .filter(entry => entry.name.startsWith(prefix))
    .slice(0, MAX_MENTION_SUGGESTIONS);

  return matches.map(entry => {
    const childPath = parentDir === '.' ? entry.name : `${parentDir}/${entry.name}`;
    const completed = entry.isDirectory ? `${childPath}/` : childPath;
    return {
      value: `@${completed}`,
      description: entry.isDirectory ? 'directory' : 'file',
      kind: 'file' as const,
    };
  });
}
