import {commandMatches} from '../command.js';

export interface SearchReductionOptions {
  maxFiles?: number;
  maxMatchesPerFile?: number;
  maxTotalMatches?: number;
}

type SearchMatch = {file: string; line: number; separator: ':' | '-'; content: string; score: number; index: number};

type SearchFile = {file: string; matches: SearchMatch[]; total: number};

const DEFAULT_OPTIONS = {maxFiles: 15, maxMatchesPerFile: 5, maxTotalMatches: 30};
const SEARCH_COMMAND = /^(?:rg|grep|git\s+grep|ag|ack)(?:\s|$)/;
const SIGNAL_LINE = /\b(error|fail(?:ed|ure)?|warn(?:ing)?|exception|panic|fatal|todo|fixme)\b/i;
const MATCH_LINE = /^(.+?)([:-])(\d+)\2(.*)$/;

export function isSearchCommand(command: string) {
  return commandMatches(command, SEARCH_COMMAND);
}

function parseSearchLine(line: string, index: number): SearchMatch | undefined {
  const match = MATCH_LINE.exec(line);
  if (!match) return undefined;
  const file = match[1]?.trim();
  const separator = match[2] as ':' | '-' | undefined;
  const lineNumber = Number(match[3]);
  if (!file || !separator || !Number.isInteger(lineNumber)) return undefined;
  return {file, line: lineNumber, separator, content: match[4] ?? '', score: SIGNAL_LINE.test(line) ? 3 : separator === ':' ? 2 : 1, index};
}

function pickMatches(matches: SearchMatch[], max: number) {
  if (matches.length <= max) return matches;
  const selected = new Map<number, SearchMatch>();
  const add = (match: SearchMatch | undefined) => { if (match) selected.set(match.index, match); };
  add(matches[0]);
  add(matches[matches.length - 1]);
  for (const match of [...matches].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (selected.size >= max) break;
    add(match);
  }
  return [...selected.values()].sort((a, b) => a.index - b.index);
}

function clipLine(line: string, max = 220) {
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

export function reduceSearchOutput(command: string, stdout: string, stderr: string, options: SearchReductionOptions = {}) {
  if (!isSearchCommand(command)) return undefined;
  const text = stdout || stderr;
  if (!text.trim()) return undefined;
  const opts = {...DEFAULT_OPTIONS, ...options};
  const parsed = text.split(/\r?\n/).map(parseSearchLine).filter((match): match is SearchMatch => match != null);
  if (parsed.length < 20) return undefined;
  if (parsed.length < Math.max(8, text.split(/\r?\n/).filter(Boolean).length * 0.6)) return undefined;

  const grouped = new Map<string, SearchMatch[]>();
  for (const match of parsed) grouped.set(match.file, [...(grouped.get(match.file) ?? []), match]);
  const files: SearchFile[] = [...grouped.entries()].map(([file, matches]) => ({file, matches, total: matches.filter(match => match.separator === ':').length || matches.length}));
  const shownFiles = files
    .sort((a, b) => Math.max(...b.matches.map(match => match.score)) - Math.max(...a.matches.map(match => match.score)) || b.total - a.total || a.file.localeCompare(b.file))
    .slice(0, opts.maxFiles);

  let shownMatches = 0;
  const output = [`Search results: ${parsed.filter(match => match.separator === ':').length || parsed.length} matches in ${files.length} files (showing up to ${opts.maxTotalMatches} matches across ${shownFiles.length} files)`];
  for (const file of shownFiles) {
    if (shownMatches >= opts.maxTotalMatches) break;
    const remaining = opts.maxTotalMatches - shownMatches;
    const picked = pickMatches(file.matches, Math.min(opts.maxMatchesPerFile, remaining));
    shownMatches += picked.length;
    output.push('', `${file.file} (${file.total} match${file.total === 1 ? '' : 'es'}, showing ${picked.length})`);
    for (const match of picked) output.push(`  ${match.line}${match.separator} ${clipLine(match.content.trim())}`);
    const omitted = file.matches.length - picked.length;
    if (omitted > 0) output.push(`  ... ${omitted} omitted in this file`);
  }
  const omittedFiles = files.length - shownFiles.length;
  if (omittedFiles > 0) output.push('', `... ${omittedFiles} more files omitted`);
  return output.join('\n');
}
