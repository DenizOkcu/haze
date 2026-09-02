import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {workspaceRelativePath} from '../../utils/path.js';
import {prepareWorkspaceMutation} from '../tools/workspaceFile.js';
import {boundedDiff, fileDiff} from '../tools/editMatch.js';
import {storeToolOutput} from '../../core/agent/toolOutputStore.js';
import {isObject, type LspRange} from './protocol.js';
import type {ToolExecutionContext} from '../tools/toolContext.js';

interface TextEdit {range: LspRange; newText: string}

function textEdits(value: unknown): TextEdit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(edit => {
    if (!isObject(edit) || !isObject(edit.range) || typeof edit.newText !== 'string') return [];
    const range = edit.range;
    if (!isObject(range.start) || !isObject(range.end)) return [];
    const line = (point: Record<string, unknown>) => ({line: Number(point.line) + 1, character: Number(point.character) + 1});
    return [{range: {start: line(range.start), end: line(range.end)}, newText: edit.newText}];
  });
}

export function workspaceEditChanges(value: unknown): Map<string, TextEdit[]> {
  const result = new Map<string, TextEdit[]>();
  if (!isObject(value)) return result;
  if (isObject(value.changes)) {
    for (const [uri, edits] of Object.entries(value.changes)) result.set(uri, [...(result.get(uri) ?? []), ...textEdits(edits)]);
  }
  if (Array.isArray(value.documentChanges)) {
    for (const change of value.documentChanges) {
      if (!isObject(change) || !isObject(change.textDocument) || typeof change.textDocument.uri !== 'string') continue;
      const uri = change.textDocument.uri;
      result.set(uri, [...(result.get(uri) ?? []), ...textEdits(change.edits)]);
    }
  }
  return result;
}

function offsetAt(text: string, line: number, character: number) {
  const lines = text.split('\n');
  let offset = 0;
  for (let index = 0; index < line - 1; index++) offset += (lines[index]?.length ?? 0) + 1;
  // LSP character positions are UTF-16 code units, as are JavaScript string offsets.
  return offset + Math.min(character - 1, lines[line - 1]?.length ?? 0);
}

export function applyTextEdits(content: string, edits: readonly TextEdit[]) {
  const located = edits.map(edit => ({...edit, start: offsetAt(content, edit.range.start.line, edit.range.start.character), end: offsetAt(content, edit.range.end.line, edit.range.end.character)}))
    .sort((a, b) => b.start - a.start);
  for (let index = 1; index < located.length; index++) if (located[index - 1]!.start < located[index]!.end) throw new Error('LSP workspace edit contains overlapping changes.');
  let updated = content;
  for (const edit of located) updated = `${updated.slice(0, edit.start)}${edit.newText}${updated.slice(edit.end)}`;
  return updated;
}

export async function applyWorkspaceEdit(toolName: string, workspaceEdit: unknown, context: ToolExecutionContext) {
  const changes = workspaceEditChanges(workspaceEdit);
  if (changes.size === 0) throw new Error('Language server returned no workspace edits.');
  const pending: Array<{path: string; absolutePath: string; original: string; updated: string}> = [];
  for (const [uri, edits] of changes) {
    if (!uri.startsWith('file://')) throw new Error(`Refusing non-file workspace edit URI: ${uri}`);
    const filePath = workspaceRelativePath(fileURLToPath(uri));
    const prepared = await prepareWorkspaceMutation(toolName, filePath, false, context);
    if (prepared.scopedStop) return prepared.scopedStop;
    const original = await fs.readFile(prepared.absolutePath, 'utf8');
    pending.push({path: filePath, absolutePath: prepared.absolutePath, original, updated: applyTextEdits(original, edits)});
  }
  for (const file of pending) await fs.writeFile(file.absolutePath, file.updated, 'utf8');
  const fullFiles = pending.map(file => ({path: file.path, ...fileDiff(file.original, file.updated)}));
  const diffLineCount = fullFiles.reduce((sum, file) => sum + file.diff.length, 0);
  const files = fullFiles.map(file => ({...file, diff: boundedDiff(file.diff, 12).diff}));
  const diffHandle = diffLineCount > files.reduce((sum, file) => sum + file.diff.length, 0)
    ? storeToolOutput(JSON.stringify(fullFiles, null, 2))
    : undefined;
  return {ok: true, changedFiles: pending.length, diffLineCount, files, ...(diffHandle ? {diffHandle} : {})};
}
