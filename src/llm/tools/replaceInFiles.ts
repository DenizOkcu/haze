import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {walkDir} from '../../utils/fs.js';
import {workspaceRoot} from '../../utils/path.js';
import {prepareWorkspaceMutation, prepareWorkspaceRead} from './workspaceFile.js';
import {createIgnoreClassifier} from './gitIgnore.js';
import {boundedDiff, fileDiff} from './editMatch.js';
import {readUtf8Prefix} from '../../core/io/boundedRead.js';
import {EXACT_MUTATION_BYTES} from '../../core/limits.js';
import {storeToolOutput} from '../../core/agent/toolOutputStore.js';
import type {ToolExecutionContext} from './toolContext.js';

export interface ReplaceInFilesInput {
  path: string;
  needle: string;
  replacement: string;
  mode: 'literal' | 'regex';
  includeGlob?: string;
  excludeGlob?: string;
  dryRun: boolean;
  occurrenceIds?: string[];
  expectedCount?: number;
}

interface Occurrence {id: string; path: string; start: number; end: number; line: number; matched: string; replacement: string}

function globRegex(glob: string) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '__HAZE_DOUBLE_STAR__').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/__HAZE_DOUBLE_STAR__/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matcher(input: ReplaceInFilesInput) {
  if (input.mode === 'literal') return new RegExp(input.needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  return new RegExp(input.needle, 'gm');
}

function occurrencesIn(filePath: string, content: string, input: ReplaceInFilesInput): Occurrence[] {
  const regex = matcher(input);
  const result: Occurrence[] = [];
  for (const match of content.matchAll(regex)) {
    const start = match.index;
    if (start == null) continue;
    const matched = match[0];
    if (matched.length === 0) throw new Error('needle must not match an empty string');
    let replacement = input.replacement;
    if (input.mode === 'regex') {
      // A sticky match retains lookaround, captures, and native $`/$' input context.
      const single = new RegExp(input.needle, 'my');
      single.lastIndex = start;
      const replaced = content.replace(single, input.replacement);
      replacement = replaced.slice(start, replaced.length - (content.length - start - matched.length));
    }
    const digest = crypto.createHash('sha256').update(`${filePath}\0${start}\0${matched}`).digest('hex').slice(0, 12);
    result.push({id: `${filePath}:${result.length}@${digest}`, path: filePath, start, end: start + matched.length, line: content.slice(0, start).split('\n').length, matched, replacement});
  }
  return result;
}

function applyOccurrences(content: string, occurrences: Occurrence[]) {
  let updated = content;
  for (const occurrence of [...occurrences].sort((a, b) => b.start - a.start)) updated = `${updated.slice(0, occurrence.start)}${occurrence.replacement}${updated.slice(occurrence.end)}`;
  return updated;
}

export async function replaceInFiles(input: ReplaceInFilesInput, context: ToolExecutionContext) {
  if (!input.needle) throw new Error('needle must not be empty');
  const base = await prepareWorkspaceRead(input.path, false, context);
  const stat = await fs.stat(base);
  const ignore = createIgnoreClassifier(workspaceRoot());
  const entries = stat.isFile() ? [{path: path.relative(workspaceRoot(), base), absolutePath: base, isFile: true, isDirectory: false, name: path.basename(base)}] : await walkDir(base, {
    recursive: true,
    maxEntries: 20_000,
    ignoreBatch: async values => await ignore.classify(values.map(value => ({path: path.relative(workspaceRoot(), value.absolutePath), isDirectory: value.isDirectory}))),
  });
  const include = input.includeGlob ? globRegex(input.includeGlob) : undefined;
  const exclude = input.excludeGlob ? globRegex(input.excludeGlob) : undefined;
  const files: Array<{path: string; absolutePath: string; content: string; occurrences: Occurrence[]}> = [];
  let skippedFiles = 0;
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const relative = path.relative(workspaceRoot(), entry.absolutePath).replace(/\\/g, '/');
    if ((include && !include.test(relative)) || exclude?.test(relative)) continue;
    let content: string;
    try {
      const safePath = await prepareWorkspaceRead(entry.absolutePath, false, context);
      const read = await readUtf8Prefix(safePath, EXACT_MUTATION_BYTES);
      if (read.truncated) continue;
      content = read.content;
    } catch { skippedFiles++; continue; }
    if (content.includes('\0')) continue;
    const occurrences = occurrencesIn(relative, content, input);
    if (occurrences.length > 0) files.push({path: relative, absolutePath: entry.absolutePath, content, occurrences});
  }
  const all = files.flatMap(file => file.occurrences);
  const fullPreview = all.map(occurrence => ({id: occurrence.id, path: occurrence.path, line: occurrence.line, before: occurrence.matched, after: occurrence.replacement}));
  const preview = fullPreview.slice(0, 100).map(occurrence => ({...occurrence, before: occurrence.before.slice(0, 200), after: occurrence.after.slice(0, 200)}));
  const occurrenceHandle = fullPreview.length > preview.length || fullPreview.some(occurrence => occurrence.before.length > 200 || occurrence.after.length > 200)
    ? storeToolOutput(JSON.stringify(fullPreview, null, 2))
    : undefined;
  const previewFields = {skippedFiles, occurrences: preview, occurrencesTruncated: occurrenceHandle != null, ...(occurrenceHandle ? {occurrenceHandle} : {})};
  if (input.dryRun) return {ok: true, dryRun: true, occurrenceCount: all.length, fileCount: files.length, ...previewFields};
  if (input.expectedCount != null && input.expectedCount !== all.length) return {ok: false, error: `expectedCount=${input.expectedCount}, but found ${all.length}; no changes applied.`, ...previewFields, recoverable: true};
  const requested = input.occurrenceIds ? new Set(input.occurrenceIds) : undefined;
  if (requested) {
    const currentIds = new Set(all.map(occurrence => occurrence.id));
    const stale = [...requested].filter(id => !currentIds.has(id));
    if (stale.length > 0) return {ok: false, error: `${stale.length} occurrence id(s) are stale or unknown; no changes applied.`, staleOccurrenceIds: stale, recoverable: true, suggestedNextStep: 'Run replaceInFiles with dryRun=true again and use the current occurrence IDs.'};
  }
  const selectedFiles = files.map(file => ({...file, selected: requested ? file.occurrences.filter(occurrence => requested.has(occurrence.id)) : file.occurrences})).filter(file => file.selected.length > 0);
  if (selectedFiles.length === 0) return {ok: false, error: 'No occurrences selected; no changes applied.', recoverable: true};
  for (const file of selectedFiles) {
    const prepared = await prepareWorkspaceMutation('replaceInFiles', file.path, false, context);
    if (prepared.scopedStop) return prepared.scopedStop;
  }
  const changed = selectedFiles.map(file => ({...file, updated: applyOccurrences(file.content, file.selected)})).filter(file => file.updated !== file.content);
  const changedPaths: string[] = [];
  for (const file of changed) {
    try {
      await fs.writeFile(file.absolutePath, file.updated, 'utf8');
      changedPaths.push(file.path);
    } catch {
      return {ok: false, changedPaths, uncertainPaths: [file.path], error: `Write failed for ${file.path}; earlier writes were not rolled back.`, recoverable: true, suggestedNextStep: 'Read the changed and uncertain paths before retrying; validate all completed changes.'};
    }
  }
  const fullFiles = changed.map(file => ({path: file.path, ...fileDiff(file.content, file.updated)}));
  const changedFiles = fullFiles.map(file => ({...file, diff: boundedDiff(file.diff, 12).diff}));
  const diffLineCount = fullFiles.reduce((sum, file) => sum + file.diff.length, 0);
  const diffHandle = diffLineCount > changedFiles.reduce((sum, file) => sum + file.diff.length, 0) ? storeToolOutput(JSON.stringify(fullFiles, null, 2)) : undefined;
  return {ok: true, dryRun: false, changedPaths, noChange: changed.length === 0, occurrenceCount: changed.reduce((sum, file) => sum + file.selected.length, 0), fileCount: changed.length, diffLineCount, files: changedFiles, ...(diffHandle ? {diffHandle} : {})};
}
