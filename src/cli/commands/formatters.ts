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
  if (typeof output?.code === 'number') return `exited with code ${output.code}`;
  if (typeof output?.ok === 'boolean') {
    if (output.ok) return 'completed';
    return typeof output.error === 'string' ? `failed: ${compact(output.error)}` : 'failed';
  }
  return 'completed';
}

export function formatSeconds(milliseconds: number) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

export function toolOutputDetails(value: unknown) {
  if (!value || typeof value !== 'object') return '';
  const output = value as {
    stdout?: {text?: string; truncated?: boolean};
    stderr?: {text?: string; truncated?: boolean};
  };
  const stdout = output.stdout?.text?.trim();
  const stderr = output.stderr?.text?.trim();
  const parts = [
    stdout ? `stdout:\n${compact(stdout, 1200)}` : '',
    stderr ? `stderr:\n${compact(stderr, 1200)}` : '',
  ].filter(Boolean);
  if (parts.length === 0) return '';
  const truncated = output.stdout?.truncated || output.stderr?.truncated;
  return `${parts.join('\n\n')}${truncated ? '\n… output truncated' : ''}`;
}
