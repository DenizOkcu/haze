import {commandCandidates} from '../command.js';

function gitSubcommand(command: string) {
  for (const candidate of commandCandidates(command)) {
    const words = candidate.toLowerCase().split(/\s+/).filter(Boolean);
    const gitIndex = words.indexOf('git');
    if (gitIndex === -1) continue;
    for (let index = gitIndex + 1; index < words.length; index++) {
      const word = words[index] ?? '';
      if (word === '-c' || word === '--git-dir' || word === '--work-tree') {
        index += 1;
        continue;
      }
      if (word.startsWith('-')) continue;
      return word;
    }
  }
  return undefined;
}

export function reduceGitOutput(command: string, stdout: string, stderr: string) {
  const text = stdout || stderr;
  const subcommand = gitSubcommand(command);
  if (subcommand === 'status') return reduceGitStatus(text);
  if (subcommand === 'log') return reduceGitLog(text);
  if (subcommand === 'diff' || subcommand === 'show') return reduceGitDiff(text, subcommand);
  return undefined;
}

function cleanStatusItem(line: string) {
  return line.trim().replace(/^\t/, '').replace(/^\s*(modified:|deleted:|new file:|renamed:)\s+/, match => `${match.trim()} `);
}

function reduceGitStatus(text: string) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return 'git status: clean';
  const porcelain = lines.filter(line => /^(?:##|\?\?|[ MADRCU?!]{2})\s+/.test(line));
  if (porcelain.length) {
    const branchLine = porcelain.find(line => line.startsWith('## '));
    const branch = branchLine?.replace(/^##\s+/, '').split('...')[0];
    const items = porcelain.filter(line => !line.startsWith('## '));
    const untracked = items.filter(line => line.startsWith('??')).length;
    const changed = items.length - untracked;
    const shown = items.slice(0, 30);
    return [`git status: ${branch ? `branch ${branch}, ` : ''}${changed} changed, ${untracked} untracked`, ...shown.map(line => `  ${line}`), ...(items.length > shown.length ? [`  ... ${items.length - shown.length} more`] : [])].join('\n');
  }

  const branch = lines.find(line => line.startsWith('On branch '))?.replace('On branch ', '');
  if (lines.some(line => /nothing to commit|working tree clean/i.test(line))) return `git status: ${branch ? `branch ${branch}, ` : ''}clean`;
  const items: string[] = [];
  let inUntracked = false;
  for (const line of lines) {
    if (/^Untracked files:/.test(line)) { inUntracked = true; continue; }
    if (/^Changes/.test(line)) { inUntracked = false; continue; }
    if (/^\s*(modified:|deleted:|new file:|renamed:)/.test(line) || (inUntracked && /^\s+\S/.test(line) && !/\(use /.test(line))) {
      const item = cleanStatusItem(line);
      if (item && !/^\(use /.test(item)) items.push(inUntracked && !/^\w+:/.test(item) ? `?? ${item}` : item);
    }
  }
  const untracked = items.filter(line => line.startsWith('?? ')).length;
  const changed = items.length - untracked;
  const shown = items.slice(0, 30);
  return [`git status: ${branch ? `branch ${branch}, ` : ''}${changed} changed, ${untracked} untracked`, ...shown.map(line => `  ${line}`), ...(items.length > shown.length ? [`  ... ${items.length - shown.length} more`] : [])].join('\n');
}

function reduceGitLog(text: string) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return 'git log: no commits shown';
  const commits: string[] = [];
  let currentHash: string | undefined;
  for (const line of lines) {
    const commit = line.match(/^commit\s+([a-f0-9]{7,40})/i);
    if (commit) {
      currentHash = commit[1]?.slice(0, 12);
      continue;
    }
    if (currentHash && /^\s{4}\S/.test(line)) {
      commits.push(`${currentHash} ${line.trim()}`);
      currentHash = undefined;
      continue;
    }
    if (/^[a-f0-9]{7,40}\s+\S/.test(line)) commits.push(line.length > 180 ? `${line.slice(0, 180)}…` : line);
  }
  const rows = (commits.length ? commits : lines).slice(0, 30);
  return [`git log: ${rows.length} commit${rows.length === 1 ? '' : 's'} shown`, ...rows.map(line => `  ${line.length > 180 ? `${line.slice(0, 180)}…` : line}`), ...(lines.length > rows.length && commits.length === 0 ? [`  ... ${lines.length - rows.length} more lines`] : [])].join('\n');
}

type DiffFile = {file: string; hunks: string[]; body: string[]; added: number; removed: number};

function reduceGitDiff(text: string, label = 'diff') {
  const lines = text.split(/\r?\n/);
  const statLines = lines.filter(line => /\|\s+\d+\s+[-+]+/.test(line) || /files? changed/.test(line)).slice(0, 40);
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const file = line.replace(/^diff --git a\//, '').replace(/ b\/.*/, '');
      current = {file, hunks: [], body: [], added: 0, removed: 0};
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@')) {
      current.hunks.push(line);
      current.body.push(line);
      continue;
    }
    if (/^(?:---|\+\+\+|index |new file mode|deleted file mode|similarity index|rename from|rename to)/.test(line)) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) current.added += 1;
    if (line.startsWith('-') && !line.startsWith('---')) current.removed += 1;
    if ((line.startsWith('+') || line.startsWith('-')) && current.body.length < 12) current.body.push(line.length > 180 ? `${line.slice(0, 180)}…` : line);
  }

  if (files.length === 0) {
    const compact = statLines.length ? statLines : lines.filter(Boolean).slice(0, 60);
    return [`git ${label}: ${compact.length ? 'summary' : 'no changes'}`, ...compact].join('\n');
  }

  const totalAdded = files.reduce((sum, file) => sum + file.added, 0);
  const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0);
  const shownFiles = files.slice(0, 30);
  const output = [`git ${label}: ${files.length} file${files.length === 1 ? '' : 's'} changed, +${totalAdded}/-${totalRemoved}`];
  for (const file of shownFiles) {
    output.push(`  ${file.file} +${file.added}/-${file.removed}${file.hunks.length ? ` (${file.hunks.length} hunk${file.hunks.length === 1 ? '' : 's'})` : ''}`);
    for (const hunk of file.hunks.slice(0, 4)) output.push(`    ${hunk}`);
    for (const bodyLine of file.body.filter(line => !line.startsWith('@@')).slice(0, 6)) output.push(`    ${bodyLine}`);
    if (file.body.length > file.hunks.length + 6) output.push(`    ... ${file.body.length - file.hunks.length - 6} diff lines omitted for this file`);
  }
  if (files.length > shownFiles.length) output.push(`  ... ${files.length - shownFiles.length} more files`);
  if (statLines.length) output.push('', ...statLines);
  return output.join('\n');
}
