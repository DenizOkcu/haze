import {listLogs, readLogEntries, summarizeLog} from '../../core/log/llmLog.js';
import {formatBytes} from '../../utils/format.js';
import {SESSION_PREVIEW_CHARS} from '../../core/limits.js';
import type {CommandContext, CommandResult} from './commands.js';

export async function handleLogsCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  const trimmed = args.trim();
  // `/logs <id> view` pages the raw JSONL through $PAGER; the suffix is part
  // of haze's syntax, not the log id.
  const viewRaw = /^(\S+)\s+view$/i.exec(trimmed);
  const id = viewRaw ? viewRaw[1]! : trimmed;

  if (!id) {
    const logs = await listLogs();
    if (logs.length === 0) {
      ctx.addSystemMessage('No log files found.');
      return 'handled';
    }
    const lines = logs.slice(0, 20).map(log => {
      const date = log.modified.slice(0, 19).replace('T', ' ');
      return `  ${log.id}  ${formatBytes(log.size).padStart(8)}  ${date}`;
    });
    ctx.addSystemMessage(['Recent logs:', '  ID                                 Size       Modified', ...lines].join('\n'));
    return 'handled';
  }

  const summary = await summarizeLog(id);
  if (!summary) {
    ctx.addSystemMessage(`No log found with id ${id}.`);
    return 'handled';
  }

  // Page raw transcripts when possible; short logs and screen-reader mode
  // still get the requested content through a bounded inline preview.
  if (viewRaw) {
    const entries = await readLogEntries(id);
    const text = entries.map(entry => JSON.stringify(entry)).join('\n');
    const paged = await ctx.viewInPager?.(text);
    if (!paged) {
      const preview = text.length > SESSION_PREVIEW_CHARS
        ? `${text.slice(0, SESSION_PREVIEW_CHARS)}\n[Raw log preview truncated; /logs ${id} shows the summary.]`
        : text || '(empty log)';
      ctx.addSystemMessage(`Log: ${id} (inline view; pager not used)\n${preview}`);
    }
    return 'handled';
  }

  const typeLines = Object.entries(summary.typeCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `  ${type}: ${count}`);

  const toolLines = Object.entries(summary.toolCallCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `  ${name}: ${count}`);

  const parts = [
    `Log: ${id}`,
    `Entries: ${summary.entries}`,
    '',
    'Entry counts by type:',
    ...typeLines,
    '',
    `Total token usage: in=${summary.totalInput} out=${summary.totalOutput}`,
  ];

  if (toolLines.length > 0) {
    parts.push('', 'Tool call counts:', ...toolLines);
  }

  ctx.addSystemMessage(parts.join('\n'));
  return 'handled';
}
