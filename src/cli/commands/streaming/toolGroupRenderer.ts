import {agentEvent, type AgentEventSink} from '../../../core/agent/events.js';
import {appendLogEntry as logAppend, type LlmLog, type LlmLogEntry} from '../../../core/log/llmLog.js';
import {toolCallSummary, compact, formatElapsedTimeWhole, formatSeconds} from '../formatters.js';

/**
 * Live "tool group" renderer for the agent turn: batches concurrent/sequential
 * tool calls into one rolling `tool` chat message with a summary header and a
 * per-call line (icon, summary, result, duration). Holds its own mutable state
 * (the active group + a 1s refresh timer) so `runAgentTurn` stays linear.
 */

export type NativeToolCall = {toolCallId: string; toolName: string; input: unknown};

export type ToolDisplayDiffLine =
  | {type: 'add' | 'remove' | 'context'; oldLine?: number; newLine?: number; text: string}
  | {type: 'gap'; omittedLines: number}
  | {type: 'meta'; text: string};
export type ToolDisplayDiff = {
  id: string;
  path: string;
  addedLines: number;
  removedLines: number;
  lines: ToolDisplayDiffLine[];
  truncated?: boolean;
  omittedLines?: number;
  handle?: string;
  complete?: boolean;
  previousContentOmittedBytes?: number;
};

export type ToolDisplayItem = {id: string; summary: string; status: 'running' | 'success' | 'error'; result?: string; startedAt: number; finishedAt?: number; durationMs?: number; showResult?: boolean; diff?: ToolDisplayDiff};
type ToolDisplayGroup = {id: string; items: ToolDisplayItem[]; started: boolean; finalized: boolean; caption?: string};

export interface ToolGroupRendererDeps {
  addMessage: (msg: {id: string; role: 'tool'; text: string; streaming: boolean; toolCount: number; toolDiffs?: ToolDisplayDiff[]}) => void;
  updateMessage: (id: string, update: {text?: string; streaming?: boolean; toolCount?: number; toolDiffs?: ToolDisplayDiff[]}) => void;
  debugLog: (line: string) => void;
  onEvent?: AgentEventSink;
  log?: LlmLog;
}

export interface ToolGroupRenderer {
  /** Find or create the display item for a tool call (rendering + logging on first sight). */
  ensureToolItem: (toolCall: NativeToolCall) => ToolDisplayItem;
  /** Re-render the active group (e.g. after mutating an item's status/result). */
  updateToolGroup: (streaming?: boolean) => void;
  /** Finalize the current group and start a fresh one (used when text resumes). */
  startFreshToolGroup: () => void;
  /** Final, non-streaming render of the active group if not already finalized. */
  finalizeToolGroup: () => void;
  /** Stop the 1s refresh timer. */
  stopToolTimer: () => void;
  /** Attach a dim caption line above the next tool group. */
  setGroupCaption: (text: string) => void;
  /** Add a scoped context-file read to the active tool group display. */
  addContextFileRead: (path: string) => void;
}

function logEntry(log: LlmLog | undefined, entry: LlmLogEntry) {
  if (log) void logAppend(log, entry).catch(() => undefined);
}

const createToolGroup = (): ToolDisplayGroup => ({id: `tools-${Date.now()}-${Math.random().toString(36).slice(2)}`, items: [], started: false, finalized: false});

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value != null ? value as Record<string, unknown> : undefined;
}

/** Extract the bounded structured diff returned by dedicated file mutation tools for rich terminal rendering. */
export function toolDiffFromResult(toolCall: NativeToolCall, output: unknown): ToolDisplayDiff | undefined {
  if (toolCall.toolName !== 'editFile' && toolCall.toolName !== 'replaceLines' && toolCall.toolName !== 'writeFile') return undefined;
  const result = record(output);
  if (!result || result.ok !== true || !Array.isArray(result.diff)) return undefined;
  const lines = result.diff.flatMap((candidate): ToolDisplayDiffLine[] => {
    const line = record(candidate);
    if (!line) return [];
    if (line.type === 'gap' && typeof line.omittedLines === 'number' && line.omittedLines > 0) {
      return [{type: 'gap', omittedLines: line.omittedLines}];
    }
    if (line.type === 'meta' && typeof line.text === 'string') return [{type: 'meta', text: line.text}];
    if ((line.type !== 'add' && line.type !== 'remove' && line.type !== 'context') || typeof line.text !== 'string') return [];
    return [{
      type: line.type,
      ...(typeof line.oldLine === 'number' ? {oldLine: line.oldLine} : {}),
      ...(typeof line.newLine === 'number' ? {newLine: line.newLine} : {}),
      text: line.text,
    }];
  });
  if (lines.length === 0) return undefined;
  const input = record(toolCall.input);
  const path = typeof result.path === 'string' ? result.path : typeof input?.path === 'string' ? input.path : 'edited file';
  return {
    id: toolCall.toolCallId,
    path,
    addedLines: typeof result.addedLines === 'number' ? result.addedLines : lines.filter(line => line.type === 'add').length,
    removedLines: typeof result.removedLines === 'number' ? result.removedLines : lines.filter(line => line.type === 'remove').length,
    lines,
    truncated: result.diffTruncated === true,
    omittedLines: typeof result.diffOmittedLines === 'number' ? result.diffOmittedLines : 0,
    ...(typeof result.diffHandle === 'string' ? {handle: result.diffHandle} : {}),
    complete: result.diffComplete !== false,
    ...(typeof result.previousContentOmittedBytes === 'number' ? {previousContentOmittedBytes: result.previousContentOmittedBytes} : {}),
  };
}

export function createToolGroupRenderer(deps: ToolGroupRendererDeps): ToolGroupRenderer {
  let toolGroup = createToolGroup();
  let toolTimer: ReturnType<typeof setInterval> | undefined;
  let pendingCaption: string | undefined;
  const setGroupCaption = (text: string) => { pendingCaption = text.trim() || undefined; };

  const renderToolGroup = (group: ToolDisplayGroup) => {
    const running = group.items.some(item => item.status === 'running');
    const failures = group.items.filter(item => item.status === 'error').length;
    const changes = group.items.filter(item => /^(editFile|replaceLines|writeFile)\b/.test(item.summary)).length;
    const elapsedMs = group.items.length > 0
      ? (running ? Date.now() : Math.max(...group.items.map(item => item.finishedAt ?? item.startedAt))) - Math.min(...group.items.map(item => item.startedAt))
      : 0;
    const summaryParts = [`${group.items.length} calls`, `${changes} changes`];
    if (failures > 0) summaryParts.push(`${failures} failed`);
    summaryParts.push(formatElapsedTimeWhole(elapsedMs));
    const lines = [summaryParts.join(' · '), ...group.items.map(item => {
      const icon = item.status === 'running' ? '…' : item.status === 'success' ? '✓' : '✗';
      const result = item.status === 'running' || item.showResult === false ? '' : ` — ${item.result ?? item.status}${item.durationMs == null ? '' : ` in ${formatSeconds(item.durationMs)}`}`;
      return `  ${icon} ${item.summary}${result}`;
    })];
    return (group.caption ? [group.caption, ...lines] : lines).join('\n');
  };

  const updateToolGroup = (streaming = true, group: ToolDisplayGroup = toolGroup) => {
    const text = renderToolGroup(group);
    const toolDiffs = group.items.flatMap(item => item.diff ? [item.diff] : []);
    // toolCount and diffs are carried structurally so metrics and rich code
    // rendering never depend on parsing the compact caption/row format.
    if (!group.started) {
      group.started = true;
      group.finalized = !streaming;
      deps.addMessage({id: group.id, role: 'tool', text, streaming, toolCount: group.items.length, toolDiffs});
    } else {
      group.finalized = !streaming;
      deps.updateMessage(group.id, {text, streaming, toolCount: group.items.length, toolDiffs});
    }
  };

  const finalizeToolGroup = (group: ToolDisplayGroup = toolGroup) => {
    if (!group.started || group.finalized) return;
    updateToolGroup(false, group);
  };

  const stopToolTimer = () => {
    if (!toolTimer) return;
    clearInterval(toolTimer);
    toolTimer = undefined;
  };

  const startToolTimer = () => {
    if (toolTimer) return;
    toolTimer = setInterval(() => {
      if (toolGroup.items.some(item => item.status === 'running')) updateToolGroup(true);
      else stopToolTimer();
    }, 1000);
  };

  const ensureToolItem = (toolCall: NativeToolCall): ToolDisplayItem => {
    if (toolGroup.finalized) toolGroup = createToolGroup();
    if (pendingCaption && toolGroup.items.length === 0) { toolGroup.caption = pendingCaption; pendingCaption = undefined; }
    let item = toolGroup.items.find(candidate => candidate.id === toolCall.toolCallId);
    if (!item) {
      item = {id: toolCall.toolCallId, summary: toolCallSummary(toolCall.toolName, toolCall.input), status: 'running', startedAt: Date.now()};
      toolGroup.items.push(item);
      deps.onEvent?.(agentEvent({type: 'tool_start', id: toolCall.toolCallId, name: toolCall.toolName, input: toolCall.input}));
      logEntry(deps.log, {at: new Date().toISOString(), type: 'tool_call', stream: 'main', toolCall: {id: toolCall.toolCallId, name: toolCall.toolName, input: toolCall.input}});
      deps.debugLog(`tool start: ${toolCall.toolName} ${compact(toolCall.input)}`);
      startToolTimer();
      updateToolGroup(true);
    }
    return item;
  };

  const startFreshToolGroup = () => {
    if (!toolGroup.started || toolGroup.items.some(item => item.status === 'running')) return;
    finalizeToolGroup(toolGroup);
    toolGroup = createToolGroup();
  };

  const addContextFileRead = (path: string) => {
    if (toolGroup.finalized) toolGroup = createToolGroup();
    if (pendingCaption && toolGroup.items.length === 0) { toolGroup.caption = pendingCaption; pendingCaption = undefined; }
    const now = Date.now();
    toolGroup.items.push({id: `context-file-${now}-${Math.random().toString(36).slice(2)}`, summary: `understanding: ${path}`, status: 'success', startedAt: now, finishedAt: now, durationMs: 0, showResult: false});
    updateToolGroup(true);
  };

  return {ensureToolItem, updateToolGroup, startFreshToolGroup, finalizeToolGroup, stopToolTimer, setGroupCaption, addContextFileRead};
}
