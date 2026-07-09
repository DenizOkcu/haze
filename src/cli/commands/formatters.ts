export function compact(value: unknown, maxLength = 180) {
  let text: string;
  if (value instanceof Error) {
    text = value.message;
  } else if (typeof value === 'string') {
    text = value;
  } else {
    text = JSON.stringify(value, (_key, nestedValue) => nestedValue instanceof Error ? nestedValue.message : nestedValue);
  }
  if (!text) return value === null ? 'null' : value === undefined ? 'undefined' : '';
  if (text === '{}') return ''; // empty object: nothing useful to render; avoid "[object Object]"
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function toolCallSummary(toolName: string, input: unknown) {
  const data = input as Record<string, unknown>;
  if (toolName === 'bash' && typeof data?.command === 'string') {
    const timeout = typeof data.timeoutSeconds === 'number' ? ` (timeout ${data.timeoutSeconds}s)` : '';
    return `bash $ ${data.command}${timeout}`;
  }
  if (toolName === 'grep' && typeof data?.pattern === 'string') {
    const path = typeof data.path === 'string' && data.path !== '.' ? ` in ${data.path}` : '';
    const glob = typeof data.glob === 'string' ? ` (${data.glob})` : '';
    return `grep "${data.pattern}"${path}${glob}`;
  }
  if (toolName === 'listFiles' && typeof data?.path === 'string') return `listFiles ${data.path}`;
  if ((toolName === 'readFile' || toolName === 'writeFile')) {
    if (typeof data?.path === 'string') return `${toolName} ${data.path}`;
    if (data == null || (typeof data === 'object' && Object.keys(data as object).length === 0)) return toolName; // input not yet streamed (tool-input-start) or empty
  }
  if (toolName === 'editFile' && typeof data?.path === 'string') {
    const edits = Array.isArray(data.edits) ? ` (${data.edits.length} edit${data.edits.length === 1 ? '' : 's'})` : '';
    return `${toolName} ${data.path}${edits}`;
  }
  if (toolName === 'replaceLines' && typeof data?.path === 'string') return `replaceLines ${data.path}:${data.startLine}-${data.endLine}`;
  if ((toolName === 'editFile' || toolName === 'replaceLines') && (data == null || (typeof data === 'object' && Object.keys(data as object).length === 0))) return toolName;
  if (toolName === 'subagent' && typeof data?.task === 'string') {
    const taskPreview = data.task.length > 60 ? `${data.task.slice(0, 60).trimEnd()}…` : data.task;
    return `subagent "${taskPreview}"`;
  }
  if (toolName === 'writeTasks') {
    const tasks = Array.isArray(data?.tasks) ? data.tasks as {title?: string}[] : [];
    return `writeTasks (${tasks.length} task${tasks.length === 1 ? '' : 's'})`;
  }
  if (toolName === 'lspWorkspaceSymbols' && typeof data?.query === 'string') return `lspWorkspaceSymbols "${data.query}"`;
  if (toolName === 'lspSymbols' && typeof data?.path === 'string') return `lspSymbols ${data.path}`;
  if ((toolName === 'lspDefinition' || toolName === 'lspReferences') && typeof data?.path === 'string') return `${toolName} ${data.path}:${data.line}:${data.column}`;
  return `${toolName} ${compact(input)}`;
}

export function toolResultSummary(event: {success: boolean; output?: unknown; error?: unknown}) {
  if (!event.success) return `failed: ${compact(event.error)}`;
  const output = event.output as Record<string, unknown> | undefined;
  if (output?.duplicateSkipped === true) return 'skipped duplicate';
  if (typeof output?.totalMatches === 'number') {
    const count = output.totalMatches as number;
    return count === 0 ? 'no matches' : `${count} match${count === 1 ? '' : 'es'}`;
  }
  if (typeof output?.validationSummary === 'object' && output.validationSummary != null && 'summaryText' in output.validationSummary) {
    const summary = output.validationSummary as {summaryText?: unknown; suggestedNextStep?: unknown};
    const next = typeof summary.suggestedNextStep === 'string' ? `; next: ${summary.suggestedNextStep}` : '';
    return `${String(summary.summaryText)}${next}`;
  }
  if (typeof output?.code === 'number') {
    const risk = typeof (output.classification as {riskLevel?: unknown} | undefined)?.riskLevel === 'string'
      ? ` (${(output.classification as {riskLevel: string}).riskLevel})`
      : '';
    return `exited with code ${output.code}${risk}`;
  }
  if (typeof output?.status === 'string' && typeof output?.summary === 'string') {
    const summary = (output.summary as string).split('\n')[0] ?? '';
    const preview = summary.length > 120 ? `${summary.slice(0, 120).trimEnd()}…` : summary;
    const calls = typeof output.toolCallCount === 'number' ? output.toolCallCount : (output.toolCalls as unknown[])?.length ?? 0;
    const duration = typeof output.durationMs === 'number' ? ` in ${(output.durationMs / 1000).toFixed(1)}s` : '';
    const meta = calls > 0 ? ` (${calls} call${calls === 1 ? '' : 's'}${duration})` : '';
    return `${output.status as string}${meta}: ${preview}`;
  }
  if (typeof output?.server === 'string' && Array.isArray(output.symbols)) {
    const count = output.symbols.length;
    return `${count} symbol${count === 1 ? '' : 's'} from ${output.server}`;
  }
  if (typeof output?.server === 'string' && Array.isArray(output.locations)) {
    const count = output.locations.length;
    return `${count} location${count === 1 ? '' : 's'} from ${output.server}`;
  }
  if (typeof output?.ok === 'boolean') {
    // writeTasks result
    if (output.ok && typeof output.summary === 'string') {
      return compact(output.summary, 120);
    }
    if (output.ok) {
      if (typeof output.addedLines === 'number' || typeof output.removedLines === 'number') {
        const added = typeof output.addedLines === 'number' ? output.addedLines : 0;
        const removed = typeof output.removedLines === 'number' ? output.removedLines : 0;
        return `Added ${added} line${added === 1 ? '' : 's'}, removed ${removed} line${removed === 1 ? '' : 's'}`;
      }
      return 'completed';
    }
    const reason = typeof output.reasonCode === 'string' ? ` (${output.reasonCode})` : '';
    return typeof output.error === 'string' ? `failed${reason}: ${compact(output.error)}` : `failed${reason}`;
  }
  return 'completed';
}

/**
 * A short, human label for the live busy indicator while a tool is running,
 * e.g. "Running command", "Reading src/foo.ts", "Searching".
 * Lets the developer see *what* is happening, not just that something is.
 */
export function busyToolLabel(toolName: string, input: unknown) {
  const data = input as Record<string, unknown>;
  const pathLabel = typeof data?.path === 'string' ? compact(data.path, 80) : undefined;
  switch (toolName) {
    case 'bash':
      return 'Running command';
    case 'grep':
      return 'Searching';
    case 'listFiles':
      return 'Listing files';
    case 'readFile':
      return pathLabel ? `Reading ${pathLabel}` : 'Reading file';
    case 'writeFile':
      return pathLabel ? `Writing ${pathLabel}` : 'Writing file';
    case 'editFile':
    case 'replaceLines':
      return pathLabel ? `Editing ${pathLabel}` : 'Editing file';
    case 'fetch':
      return 'Fetching URL';
    case 'subagent':
      return 'Running subagent';
    case 'writeTasks':
      return 'Updating tasks';
    case 'skill':
      return 'Loading skill';
    default:
      if (toolName.startsWith('lsp')) return 'Querying LSP';
      if (toolName.startsWith('mcp')) return 'Running MCP tool';
      return `Running ${toolName}`;
  }
}

export function formatSeconds(milliseconds: number) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

export function formatElapsedTime(milliseconds: number) {
  const totalSeconds = Math.max(0, milliseconds / 1000);
  const wholeSeconds = Math.floor(totalSeconds);
  const seconds = totalSeconds - Math.floor(wholeSeconds / 60) * 60;
  const totalMinutes = Math.floor(wholeSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const secondsLabel = `${seconds.toFixed(1)}s`;
  if (hours > 0) return `${hours}h ${minutes}m ${secondsLabel}`;
  if (minutes > 0) return `${minutes}m ${secondsLabel}`;
  return secondsLabel;
}

export function formatElapsedTimeWhole(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function toolOutputDetails(value: unknown) {
  if (!value || typeof value !== 'object') return '';
  const output = value as {
    cwd?: string;
    classification?: {riskLevel?: string; reason?: string; traits?: string[]};
    validationSummary?: {summaryText?: string; suggestedNextStep?: string};
    stdout?: {text?: string; truncated?: boolean};
    stderr?: {text?: string; truncated?: boolean};
  };
  const stdout = output.stdout?.text?.trim();
  const stderr = output.stderr?.text?.trim();
  const meta = [
    output.cwd ? `cwd: ${output.cwd}` : '',
    output.classification?.riskLevel ? `classification: ${output.classification.riskLevel}${output.classification.reason ? ` — ${output.classification.reason}` : ''}` : '',
    output.validationSummary?.summaryText ? `validation: ${output.validationSummary.summaryText}${output.validationSummary.suggestedNextStep ? `\nnext: ${output.validationSummary.suggestedNextStep}` : ''}` : '',
  ].filter(Boolean).join('\n');
  const parts = [
    meta,
    stdout ? `stdout:\n${compact(stdout, 1200)}` : '',
    stderr ? `stderr:\n${compact(stderr, 1200)}` : '',
  ].filter(Boolean);
  if (parts.length === 0) return '';
  const truncated = output.stdout?.truncated || output.stderr?.truncated;
  return `${parts.join('\n\n')}${truncated ? '\n… output truncated' : ''}`;
}

export type ContextReportCategory = 'builtin' | 'lsp' | 'skill' | 'subagent' | 'mcp';

export interface ContextReportTool {
  name: string;
  tokens: number;
  category: ContextReportCategory;
}

export interface ContextReportData {
  modelLabel: string;
  systemTokens: number;
  projectContext: Array<{path: string; tokens: number}>;
  tools: ContextReportTool[];
  /** Full-message token totals by role (already includes tool call/result parts). */
  messagesByRole: Record<string, number>;
  /** Tool-result part tokens by tool name (subset of the messages total). */
  toolResults: Record<string, number>;
  /** Tool-call input part tokens by tool name (subset of the messages total). */
  toolInputs: Record<string, number>;
  syntheticControl: number;
  logicalInputEstimate: number;
  messageCount: number;
  mcpErrors: string[];
}

const CONTEXT_CATEGORY_LABEL: Record<ContextReportCategory, string> = {
  builtin: 'Built-in',
  lsp: 'LSP',
  skill: 'Skills',
  subagent: 'Subagent',
  mcp: 'MCP',
};
const CONTEXT_CATEGORY_ORDER: ContextReportCategory[] = ['builtin', 'lsp', 'skill', 'subagent', 'mcp'];

function num(n: number) {
  return Math.round(n).toLocaleString('en-US');
}

// Bar chart glyphs: full block, 1/8..7/8 left-fill blocks, and a light track.
const BAR_FULL = '█';
const BAR_EMPTY = '░';
const BAR_PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/** A fixed-width horizontal bar; `value` vs `max` controls the filled fraction. */
function bar(value: number, max: number, width: number) {
  if (width <= 0) return '';
  if (max <= 0 || value <= 0) return BAR_EMPTY.repeat(width);
  const scaled = Math.min(1, value / max) * width;
  let whole = Math.floor(scaled);
  let partial = Math.round((scaled - whole) * 8); // 0..8
  if (partial >= 8) {whole += 1; partial = 0;}
  whole = Math.min(whole, width);
  if (whole === 0 && partial === 0 && value > 0) partial = 1; // ensure a sliver for any nonzero value
  const partialGlyph = (whole < width && partial > 0) ? BAR_PARTIAL[partial] : '';
  const filled = BAR_FULL.repeat(whole);
  const emptyCount = width - filled.length - partialGlyph.length;
  return `${filled}${partialGlyph}${emptyCount > 0 ? BAR_EMPTY.repeat(emptyCount) : ''}`;
}

function row(label: string, tokens: number, total: number, labelCol: number, numCol: number, barWidth: number, indent = 0) {
  const prefix = `${' '.repeat(indent)}${label}`.padEnd(labelCol);
  const pct = total > 0 ? `${Math.round((tokens / total) * 100)}%`.padStart(4) : '   -';
  return `${prefix}${bar(tokens, total, barWidth)}  ${num(tokens).padStart(numCol)}  ${pct}`;
}

/** Render a detailed, /context-style token breakdown. Pure for testability. */
export function formatContextReport(data: ContextReportData): string {
  const lines: string[] = [];
  lines.push(`Context overview — model: ${data.modelLabel}`);
  lines.push(`Estimated input: ~${num(data.logicalInputEstimate)} tokens (4 chars/token heuristic). Bars show each row's share of that total; tool results/inputs are subsets of the messages total.`);
  lines.push('');

  const projectTokens = data.projectContext.reduce((sum, file) => sum + file.tokens, 0);
  const toolsTotal = data.tools.reduce((sum, tool) => sum + tool.tokens, 0);
  const messagesTotal = Object.values(data.messagesByRole).reduce((sum, value) => sum + value, 0);
  const resultsTotal = Object.values(data.toolResults).reduce((sum, value) => sum + value, 0);
  const inputsTotal = Object.values(data.toolInputs).reduce((sum, value) => sum + value, 0);

  const numberValues = [
    data.systemTokens, toolsTotal, messagesTotal, data.logicalInputEstimate, projectTokens, resultsTotal, inputsTotal,
    ...data.tools.map(tool => tool.tokens),
    ...Object.values(data.toolResults), ...Object.values(data.toolInputs),
    ...data.projectContext.map(file => file.tokens),
    ...Object.values(data.messagesByRole),
  ];
  const numCol = Math.max(8, ...numberValues.map(value => num(value).length));
  const labels = [
    'System prompt', 'project context', 'base instructions', '(no project context files)',
    `Tools (${data.tools.length})`, `Chat messages (${data.messageCount})`,
    'tool results', 'tool inputs', 'synthetic control',
    ...data.tools.map(tool => tool.name),
    ...data.projectContext.map(file => file.path),
    ...Object.keys(data.messagesByRole),
    ...Object.keys(data.toolResults), ...Object.keys(data.toolInputs),
  ];
  // Indented labels gain up to 4 spaces of leading indent; padEnd accounts for that.
  const labelCol = Math.max(28, ...labels.map(label => label.length + 4)) + 2;
  const barWidth = 20;
  const r = (label: string, tokens: number, indent = 0) => row(label, tokens, data.logicalInputEstimate, labelCol, numCol, barWidth, indent);

  // System prompt
  lines.push(r('System prompt', data.systemTokens));
  if (data.projectContext.length > 0) {
    lines.push(r('project context', projectTokens, 2));
    for (const file of [...data.projectContext].sort((a, b) => b.tokens - a.tokens)) lines.push(r(file.path, file.tokens, 4));
    lines.push(r('base instructions', data.systemTokens - projectTokens, 2));
  } else {
    lines.push(r('(no project context files)', 0, 2));
  }
  lines.push('');

  // Tools
  lines.push(r(`Tools (${data.tools.length})`, toolsTotal));
  for (const category of CONTEXT_CATEGORY_ORDER) {
    const inCategory = data.tools.filter(tool => tool.category === category).sort((a, b) => b.tokens - a.tokens);
    if (inCategory.length === 0) continue;
    const categoryTotal = inCategory.reduce((sum, tool) => sum + tool.tokens, 0);
    lines.push(r(`${CONTEXT_CATEGORY_LABEL[category]} (${inCategory.length})`, categoryTotal, 2));
    for (const tool of inCategory) lines.push(r(tool.name, tool.tokens, 4));
  }
  if (data.mcpErrors.length > 0) {
    lines.push('');
    lines.push(`MCP errors: ${data.mcpErrors.join('; ')}`);
  }
  lines.push('');

  // Messages
  lines.push(r(`Chat messages (${data.messageCount})`, messagesTotal));
  for (const role of Object.keys(data.messagesByRole).sort()) lines.push(r(role, data.messagesByRole[role], 2));
  if (resultsTotal > 0 || inputsTotal > 0) {
    lines.push('');
    lines.push('Tool content inside messages (already counted above; bars are share of total input):');
    if (resultsTotal > 0) {
      lines.push(r('tool results', resultsTotal, 2));
      for (const [name, value] of [...Object.entries(data.toolResults)].sort(([, a], [, b]) => b - a)) lines.push(r(name, value, 4));
    }
    if (inputsTotal > 0) {
      lines.push(r('tool inputs', inputsTotal, 2));
      for (const [name, value] of [...Object.entries(data.toolInputs)].sort(([, a], [, b]) => b - a)) lines.push(r(name, value, 4));
    }
  }
  if (data.syntheticControl > 0) lines.push(r('synthetic control', data.syntheticControl, 2));

  return lines.join('\n');
}
