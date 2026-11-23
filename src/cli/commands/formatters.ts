import {formatBytes} from '../../utils/format.js';

// The one-line tool call/result/busy-label builders live in `chat/toolSummaries.ts`
// (ARCH-03) and are re-exported here for the transcript formatters' callers.
export {busyToolLabel, compact, toolCallSummary, toolResultSummary} from '../chat/toolSummaries.js';

/** Compact transcript row for a user-attached image (F03); never dumps bytes. */
export function imageAttachmentLine(attachment: {fileName: string; bytes: number}) {
  return `🖼 ${attachment.fileName} (${formatBytes(attachment.bytes)})`;
}

type ContextReportCategory = 'builtin' | 'lsp' | 'skill' | 'subagent' | 'mcp';

interface ContextReportTool {
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
