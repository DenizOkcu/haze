export function compact(value: unknown, maxLength = 180) {
  let text: string;
  if (value instanceof Error) {
    text = value.message;
  } else if (typeof value === 'string') {
    text = value;
  } else {
    text = JSON.stringify(value, (_key, nestedValue) => nestedValue instanceof Error ? nestedValue.message : nestedValue);
  }
  if (!text || text === '{}') return String(value);
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
  if ((toolName === 'readFile' || toolName === 'writeFile') && typeof data?.path === 'string') return `${toolName} ${data.path}`;
  if (toolName === 'editFile' && typeof data?.path === 'string') {
    const edits = Array.isArray(data.edits) ? ` (${data.edits.length} edit${data.edits.length === 1 ? '' : 's'})` : '';
    return `${toolName} ${data.path}${edits}`;
  }
  if (toolName === 'replaceLines' && typeof data?.path === 'string') return `replaceLines ${data.path}:${data.startLine}-${data.endLine}`;
  if (toolName === 'subagent' && typeof data?.task === 'string') {
    const taskPreview = data.task.length > 60 ? `${data.task.slice(0, 60).trimEnd()}…` : data.task;
    return `subagent "${taskPreview}"`;
  }
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
  if (output?.needsConfirmation === true) {
    const reasonCode = typeof output.reasonCode === 'string' ? ` (${output.reasonCode})` : '';
    return `blocked pending confirmation${reasonCode}`;
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
  if (typeof output?.ok === 'boolean') {
    if (output.ok) {
      if (typeof output.addedLines === 'number' || typeof output.removedLines === 'number') {
        const added = typeof output.addedLines === 'number' ? output.addedLines : 0;
        const removed = typeof output.removedLines === 'number' ? output.removedLines : 0;
        return `Added ${added} line${added === 1 ? '' : 's'}, removed ${removed} line${removed === 1 ? '' : 's'}`;
      }
      return 'completed';
    }
    if (output.needsConfirmation === true) return `blocked pending confirmation: ${compact(output.error)}`;
    const reason = typeof output.reasonCode === 'string' ? ` (${output.reasonCode})` : '';
    return typeof output.error === 'string' ? `failed${reason}: ${compact(output.error)}` : `failed${reason}`;
  }
  return 'completed';
}

export function formatSeconds(milliseconds: number) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
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
