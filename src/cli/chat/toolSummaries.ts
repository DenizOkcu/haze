import {stripTerminalControlSequences} from '../../ui/terminalSanitize.js';

/**
 * Pure one-line builders for tool calls, tool results and the busy label
 * (compact, toolCallSummary, toolResultSummary, busyToolLabel): the transcript
 * vocabulary shared by commands/formatters.ts (which re-exports them) and by
 * the turn engine under commands/streaming/, which records them into display
 * state while a step runs (ARCH-03).
 */
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

/**
 * One-line summary of a tool call for the transcript rows. Wraps the raw
 * builder: paths, patterns, and commands are model/repo-derived, so terminal
 * control sequences are stripped at this sink (HZA-3).
 */
export function toolCallSummary(toolName: string, input: unknown) {
  return stripTerminalControlSequences(toolCallSummaryText(toolName, input));
}

function toolCallSummaryText(toolName: string, input: unknown) {
  const data = input as Record<string, unknown>;
  if (toolName === 'shell' && typeof data?.command === 'string') {
    const mode = data.background === true ? ' (background)' : typeof data.timeoutSeconds === 'number' ? ` (timeout ${data.timeoutSeconds}s)` : '';
    return `shell $ ${data.command}${mode}`;
  }
  if (toolName === 'process' && typeof data?.action === 'string') return `process ${data.action}${typeof data.backgroundId === 'string' ? ` ${data.backgroundId}` : ''}`;
  if (toolName.startsWith('git')) {
    const detail = typeof data?.path === 'string' && data.path !== '.' ? ` ${data.path}`
      : typeof data?.range === 'string' ? ` ${data.range}`
      : toolName === 'gitBranchManage' && typeof data?.action === 'string' && typeof data?.name === 'string' ? ` ${data.action} ${data.name}`
      : toolName === 'gitCommit' && typeof data?.message === 'string' ? ` "${compact(data.message, 60)}"`
      : toolName === 'gitStage' && Array.isArray(data?.paths) ? ` ${data.paths.join(', ')}`
      : '';
    return `${toolName}${detail}`;
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
  if (toolName === 'replaceInFiles' && typeof data?.needle === 'string') return `replaceInFiles "${compact(data.needle, 60)}"${typeof data.path === 'string' && data.path !== '.' ? ` in ${data.path}` : ''}${data.dryRun === false ? '' : ' (dry run)'}`;
  if (toolName === 'replaceLines' && typeof data?.path === 'string') return `replaceLines ${data.path}:${data.startLine}-${data.endLine}`;
  if ((toolName === 'editFile' || toolName === 'replaceInFiles' || toolName === 'replaceLines') && (data == null || (typeof data === 'object' && Object.keys(data as object).length === 0))) return toolName;
  if (toolName === 'subagent') {
    const task = typeof data?.objective === 'string' ? data.objective : typeof data?.task === 'string' ? data.task : undefined;
    if (task) {
      const taskPreview = task.length > 60 ? `${task.slice(0, 60).trimEnd()}…` : task;
      return `subagent "${taskPreview}"`;
    }
  }
  if (toolName === 'writeTasks') {
    const tasks = Array.isArray(data?.tasks) ? data.tasks as {title?: string}[] : [];
    return `writeTasks (${tasks.length} task${tasks.length === 1 ? '' : 's'})`;
  }
  if (toolName === 'lspWorkspaceSymbols' && typeof data?.query === 'string') return `lspWorkspaceSymbols "${data.query}"`;
  if (toolName === 'lspSymbols' && typeof data?.path === 'string') return `lspSymbols ${data.path}`;
  if ((toolName === 'lspFindSymbol' || toolName === 'lspRenameSymbol' || toolName === 'lspSafeDeleteSymbol' || toolName === 'lspDiagnosticsForSymbol') && typeof data?.namePath === 'string') return `${toolName} ${typeof data.path === 'string' ? `${data.path}:` : ''}${data.namePath}`;
  if (toolName === 'lspDiagnostics' && typeof data?.path === 'string') return `lspDiagnostics ${data.path}`;
  if ((toolName === 'lspDefinition' || toolName === 'lspTypeDefinition' || toolName === 'lspImplementation' || toolName === 'lspReferences') && typeof data?.path === 'string') return `${toolName} ${data.path}:${data.line}:${data.column}`;
  if (toolName === 'graphQuery' && typeof data?.question === 'string') return `map: query "${compact(data.question, 60)}"`;
  if ((toolName === 'graphExplain' || toolName === 'graphAffected') && typeof data?.symbol === 'string') return `map: ${toolName === 'graphExplain' ? 'explain' : 'affected'} ${data.symbol}`;
  if (toolName === 'graphPath' && typeof data?.from === 'string' && typeof data?.to === 'string') return `map: path ${data.from} -> ${data.to}`;
  if (toolName === 'graphRebuild') return 'map: rebuild';
  return `${toolName} ${compact(input)}`;
}

/**
 * One-line summary of a tool result for the transcript rows; same terminal
 * control-sequence sink discipline as `toolCallSummary` (HZA-3).
 */
export function toolResultSummary(event: {success: boolean; output?: unknown; error?: unknown}) {
  return stripTerminalControlSequences(toolResultSummaryText(event));
}

function toolResultSummaryText(event: {success: boolean; output?: unknown; error?: unknown}) {
  const output = event.output as Record<string, unknown> | undefined;
  if (!event.success) return `failed: ${compact(event.error ?? output?.error ?? event.output)}`;
  if (output?.duplicateSkipped === true) return 'skipped duplicate';
  if (output?.background === true && typeof output.backgroundId === 'string') {
    return `⏵ ${output.backgroundId} ${compact(output.command, 80)}${typeof output.pid === 'number' ? ` (pid ${output.pid})` : ''}`;
  }
  if (typeof output?.totalMatches === 'number') {
    const count = output.totalMatches as number;
    return count === 0 ? 'no matches' : `${output.matchCountIsLowerBound === true ? 'at least ' : ''}${count} match${count === 1 ? '' : 'es'}`;
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
  const resultOutput = output ?? {};
  const capsule = typeof resultOutput.capsule === 'object' && resultOutput.capsule != null ? resultOutput.capsule as Record<string, unknown> : undefined;
  if (capsule && typeof capsule.termination === 'string' && typeof capsule.deliverable === 'string') {
    const summary = capsule.deliverable.split('\n')[0] ?? '';
    const preview = summary.length > 120 ? `${summary.slice(0, 120).trimEnd()}…` : summary;
    const telemetry = typeof resultOutput.telemetry === 'object' && resultOutput.telemetry != null ? resultOutput.telemetry as Record<string, unknown> : undefined;
    const calls = typeof telemetry?.toolCallCount === 'number' ? telemetry.toolCallCount : typeof resultOutput.toolCallCount === 'number' ? resultOutput.toolCallCount : 0;
    const durationMs = typeof telemetry?.durationMs === 'number' ? telemetry.durationMs : resultOutput.durationMs;
    const duration = typeof durationMs === 'number' ? ` in ${(durationMs / 1000).toFixed(1)}s` : '';
    const meta = calls > 0 ? ` (${calls} call${calls === 1 ? '' : 's'}${duration})` : '';
    return `${capsule.termination}${capsule.usable === false ? ' · unusable' : ''}${capsule.truncated === true ? ' · truncated' : ''}${meta}: ${preview}`;
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
  if (typeof output?.answer === 'string' && typeof output?.graph === 'object') {
    // graphQuery/graphPath answers
    const stale = (output.graph as {stale?: unknown}).stale === true ? ' · stale graph' : '';
    const seeds = typeof output.seeds === 'number' ? `${output.seeds} seed${output.seeds === 1 ? '' : 's'}` : typeof output.hops === 'number' ? `${output.hops} hop${output.hops === 1 ? '' : 's'}` : '';
    return `${seeds}${stale}: ${compact(output.answer, 120)}`;
  }
  if (Array.isArray(output?.affected) && typeof output.symbol === 'string') {
    const count = (output.affected as unknown[]).length;
    return count === 0 ? `no reverse relationships for ${output.symbol}` : `${count} affected by ${output.symbol}`;
  }
  if (typeof output?.nodes === 'number' && typeof output?.edges === 'number' && output?.toolName === 'graphRebuild') {
    return `graph built: ${output.nodes} nodes · ${output.edges} edges · ${output.files} files`;
  }
  if (typeof output?.ok === 'boolean') {
    // writeTasks result
    if (output.ok && typeof output.summary === 'string') {
      return compact(output.summary, 120);
    }
    if (output.ok) {
      if (output.noChange === true) return 'No changes made';
      if (typeof output.addedLines === 'number' || typeof output.removedLines === 'number') {
        const added = typeof output.addedLines === 'number' ? output.addedLines : 0;
        const removed = typeof output.removedLines === 'number' ? output.removedLines : 0;
        return `Added ${added} line${added === 1 ? '' : 's'}, removed ${removed} line${removed === 1 ? '' : 's'}`;
      }
      return 'completed';
    }
    if (output.reasonCode === 'secret_file_protected' || output.reasonCode === 'git_internals_protected') {
      // Protection events are visible but distinct from ordinary failures so
      // the developer can audit them at a glance; never print file contents.
      const protectedPath = typeof output.path === 'string' && output.path ? ` (${compact(output.path, 80)})` : '';
      const kind = output.reasonCode === 'secret_file_protected' ? 'protected secret file' : 'protected git internals';
      return `blocked: ${kind}${protectedPath}`;
    }
    const reason = typeof output.reasonCode === 'string' ? ` (${output.reasonCode})` : '';
    return typeof output.error === 'string' ? `failed${reason}: ${compact(output.error)}` : `failed${reason}`;
  }
  return 'completed';
}

/**
 * The short head of a shell command for the busy label: the program plus its
 * first non-flag argument ("git diff", "npm test") — enough to identify the
 * action without echoing the full (possibly long or sensitive) command line.
 */
function commandHead(command: string) {
  const parts = command.trim().split(/\s+/);
  const head = [parts[0]];
  for (const part of parts.slice(1)) {
    if (part.startsWith('-')) continue;
    head.push(part);
    break;
  }
  return compact(head.filter(Boolean).join(' '), 80);
}

/**
 * A short, human label for the live busy indicator while a tool is running,
 * e.g. "Running npm test", "Reading src/foo.ts", "Searching".
 * Lets the developer see *what* is happening, not just that something is.
 */
export function busyToolLabel(toolName: string, input: unknown) {
  const data = input as Record<string, unknown>;
  const pathLabel = typeof data?.path === 'string' ? compact(data.path, 80) : undefined;
  switch (toolName) {
    case 'shell':
      if (data?.background === true) return 'Starting background process';
      return typeof data?.command === 'string' && data.command ? `Running ${commandHead(data.command)}` : 'Running command';
    case 'process':
      return 'Managing background process';
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
    case 'graphQuery':
    case 'graphExplain':
    case 'graphPath':
    case 'graphAffected':
      return 'Querying code graph';
    case 'graphRebuild':
      return 'Building code graph';
    case 'skill':
      return 'Loading skill';
    default:
      if (toolName.startsWith('lsp')) return 'Querying LSP';
      if (toolName.startsWith('mcp')) return 'Running MCP tool';
      return `Running ${toolName}`;
  }
}
