import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {workspaceRelativePath} from '../../utils/path.js';
import {prepareWorkspaceMutation} from '../tools/workspaceFile.js';
import {boundedDiff, fileDiff} from '../tools/editMatch.js';
import {storeToolOutput} from '../../core/agent/toolOutputStore.js';
import {isObject, type LspRange} from './protocol.js';
import type {ToolExecutionContext} from '../tools/toolContext.js';
import {readUtf8Prefix} from '../../core/io/boundedRead.js';
import {EXACT_MUTATION_BYTES} from '../../core/limits.js';

interface TextEdit {range: LspRange; newText: string}

function textEdits(value: unknown): TextEdit[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('Invalid or oversized LSP edit list.');
  return value.map(edit => {
    if (!isObject(edit) || !isObject(edit.range) || typeof edit.newText !== 'string') throw new Error('Invalid LSP text edit.');
    const point = (value: unknown) => {
      if (!isObject(value) || !Number.isSafeInteger(value.line) || !Number.isSafeInteger(value.character)
        || (value.line as number) < 0 || (value.character as number) < 0) throw new Error('Invalid LSP edit position.');
      return {line: (value.line as number) + 1, character: (value.character as number) + 1};
    };
    const range = {start: point(edit.range.start), end: point(edit.range.end)};
    assertOrderedRange(range);
    return {range, newText: edit.newText};
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

function assertOrderedRange(range: LspRange) {
  if (range.start.line > range.end.line || (range.start.line === range.end.line && range.start.character > range.end.character)) throw new Error('Reversed LSP edit range.');
}

function offsetAt(text: string, line: number, character: number) {
  const lines = text.split('\n');
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(character) || line < 1 || line > lines.length || character < 1) throw new Error('LSP edit position is outside the document.');
  let offset = 0;
  for (let index = 0; index < line - 1; index++) offset += (lines[index]?.length ?? 0) + 1;
  // LSP character positions are UTF-16 code units, as are JavaScript string offsets.
  const lineLength = lines[line - 1]!.replace(/\r$/, '').length;
  if (character - 1 > lineLength) throw new Error('LSP edit position is outside the document.');
  return offset + character - 1;
}

export function applyTextEdits(content: string, edits: readonly TextEdit[]) {
  for (const edit of edits) assertOrderedRange(edit.range);
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
  if (changes.size > 100 || [...changes.values()].reduce((sum, edits) => sum + edits.length, 0) > 10_000
    || [...changes.values()].flat().reduce((sum, edit) => sum + Buffer.byteLength(edit.newText), 0) > EXACT_MUTATION_BYTES) throw new Error('LSP workspace edit exceeds the aggregate edit limit.');
  let remainingBytes = EXACT_MUTATION_BYTES;
  const pending: Array<{path: string; absolutePath: string; original: string; updated: string}> = [];
  for (const [uri, edits] of changes) {
    if (!uri.startsWith('file://')) throw new Error(`Refusing non-file workspace edit URI: ${uri}`);
    const filePath = workspaceRelativePath(fileURLToPath(uri));
    const prepared = await prepareWorkspaceMutation(toolName, filePath, false, context);
    if (prepared.scopedStop) return prepared.scopedStop;
    const read = await readUtf8Prefix(prepared.absolutePath, remainingBytes);
    if (read.truncated) throw new Error('LSP workspace edit exceeds the aggregate document limit.');
    const original = read.content;
    remainingBytes -= Buffer.byteLength(original);
    const updated = applyTextEdits(original, edits);
    if (updated !== original) pending.push({path: filePath, absolutePath: prepared.absolutePath, original, updated});
  }
  const changedPaths: string[] = [];
  for (const file of pending) {
    try {
      await fs.writeFile(file.absolutePath, file.updated, 'utf8');
      changedPaths.push(file.path);
    } catch {
      return {ok: false, changedPaths, uncertainPaths: [file.path], error: `Write failed for ${file.path}; earlier writes were not rolled back.`, recoverable: true, suggestedNextStep: 'Read the changed and uncertain paths before retrying; validate all completed changes.'};
    }
  }
  const fullFiles = pending.map(file => ({path: file.path, ...fileDiff(file.original, file.updated)}));
  const diffLineCount = fullFiles.reduce((sum, file) => sum + file.diff.length, 0);
  const files = fullFiles.map(file => ({...file, diff: boundedDiff(file.diff, 12).diff}));
  const diffHandle = diffLineCount > files.reduce((sum, file) => sum + file.diff.length, 0)
    ? storeToolOutput(JSON.stringify(fullFiles, null, 2))
    : undefined;
  return {ok: true, changedPaths, noChange: pending.length === 0, changedFiles: pending.length, diffLineCount, files, ...(diffHandle ? {diffHandle} : {})};
}
