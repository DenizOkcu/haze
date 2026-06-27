export function clip(line: string, max = 220) {
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed || !/^(?:\[|\{)/.test(trimmed)) return undefined;
  try { return JSON.parse(trimmed) as unknown; } catch { return undefined; }
}

function summarizeJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 2) return '[nested omitted]';
  if (Array.isArray(value)) return {type: 'array', length: value.length, sample: value.slice(0, 3).map(item => summarizeJsonValue(item, depth + 1))};
  if (typeof value === 'object' && value != null) {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source);
    const result: Record<string, unknown> = {keys};
    for (const key of keys.slice(0, 20)) result[key] = summarizeJsonValue(source[key], depth + 1);
    if (keys.length > 20) result.omittedKeys = keys.length - 20;
    return result;
  }
  return value;
}

export function reduceJsonOutput(stdout: string, stderr: string) {
  const stream = stdout.trim() ? stdout : stderr;
  const parsed = tryParseJson(stream);
  if (parsed == null) return undefined;
  if (Array.isArray(parsed)) {
    if (parsed.length < 8 && stream.length < 4000) return undefined;
    const objectItems = parsed.filter(item => typeof item === 'object' && item != null && !Array.isArray(item)) as Array<Record<string, unknown>>;
    const keyCounts = new Map<string, number>();
    for (const item of objectItems) for (const key of Object.keys(item)) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    const commonKeys = [...keyCounts.entries()].filter(([, count]) => count >= Math.max(2, objectItems.length * 0.7)).map(([key]) => key).slice(0, 30);
    const anomalyIndexes = objectItems
      .map((item, index) => ({item, index, hasSignal: Object.values(item).some(value => typeof value === 'string' && /error|fail|warn|denied|invalid|missing/i.test(value))}))
      .filter(entry => entry.hasSignal)
      .slice(0, 5);
    const sampleIndexes = new Set([0, 1, 2, parsed.length - 2, parsed.length - 1, ...anomalyIndexes.map(entry => entry.index)].filter(index => index >= 0 && index < parsed.length));
    const sample = [...sampleIndexes].sort((a, b) => a - b).map(index => ({index, value: summarizeJsonValue(parsed[index])}));
    return JSON.stringify({jsonSummary: {type: 'array', items: parsed.length, commonKeys, sample, omittedItems: Math.max(0, parsed.length - sample.length)}}, null, 2);
  }
  if (typeof parsed === 'object' && parsed != null && stream.length >= 4000) {
    return JSON.stringify({jsonSummary: summarizeJsonValue(parsed)}, null, 2);
  }
  return undefined;
}

export function reduceUnifiedDiffOutput(stdout: string, stderr: string) {
  const text = stdout || stderr;
  if (!/(^|\n)(diff --git |@@\s+-\d|---\s+\S+\n\+\+\+\s+\S+)/.test(text)) return undefined;
  const lines = text.split(/\r?\n/);
  if (lines.length < 80 && text.length < 8000) return undefined;
  const files: Array<{file: string; hunks: string[]; added: number; removed: number; body: string[]}> = [];
  let current: (typeof files)[number] | undefined;
  for (const line of lines) {
    const fileLine = line.match(/^diff --git a\/(.*?) b\//) ?? line.match(/^\+\+\+\s+b\/(.+)$/);
    if (fileLine && (!current || line.startsWith('diff --git'))) {
      current = {file: fileLine[1] ?? 'unknown', hunks: [], added: 0, removed: 0, body: []};
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@')) {
      current.hunks.push(line);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.added += 1;
      if (current.body.length < 8) current.body.push(clip(line));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      current.removed += 1;
      if (current.body.length < 8) current.body.push(clip(line));
    }
  }
  if (!files.length) return undefined;
  const totalAdded = files.reduce((sum, file) => sum + file.added, 0);
  const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0);
  const output = [`diff: ${files.length} file${files.length === 1 ? '' : 's'} changed, +${totalAdded}/-${totalRemoved}`];
  for (const file of files.slice(0, 30)) {
    output.push(`  ${file.file} +${file.added}/-${file.removed}${file.hunks.length ? ` (${file.hunks.length} hunks)` : ''}`);
    for (const hunk of file.hunks.slice(0, 4)) output.push(`    ${hunk}`);
    for (const body of file.body.slice(0, 6)) output.push(`    ${body}`);
  }
  if (files.length > 30) output.push(`  ... ${files.length - 30} more files`);
  return output.join('\n');
}

export function reduceGenericLogOutput(stdout: string, stderr: string) {
  const text = `${stdout}${stderr ? `\n${stderr}` : ''}`;
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 120 && text.length < 12000) return undefined;
  const signalIndexes = new Set<number>();
  const signalPattern = /\b(error|failed|failure|fatal|exception|panic|traceback|assert|warning|warn|denied|timeout|timed out)\b/i;
  lines.forEach((line, index) => {
    if (!signalPattern.test(line)) return;
    for (let i = Math.max(0, index - 2); i <= Math.min(lines.length - 1, index + 4); i++) signalIndexes.add(i);
  });
  const summaryLines = lines.filter(line => /\b(\d+\s+(passed|failed|skipped|errors?)|tests?\s+run|build\s+(success|failed)|success|failed)\b/i.test(line)).slice(-10);
  const selected = [...signalIndexes].sort((a, b) => a - b).slice(0, 120).map(index => clip(lines[index] ?? ''));
  if (!selected.length && !summaryLines.length) return undefined;
  const output = [`log summary: ${lines.length} lines, ${signalIndexes.size} signal/context lines`];
  if (summaryLines.length) output.push('', 'summaries:', ...summaryLines.map(line => `  ${clip(line)}`));
  if (selected.length) output.push('', 'signal excerpts:', ...selected.map(line => `  ${line}`));
  const omitted = lines.length - selected.length - summaryLines.length;
  if (omitted > 0) output.push('', `... ${omitted} non-signal lines omitted`);
  return output.join('\n');
}
