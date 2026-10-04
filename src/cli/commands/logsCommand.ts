import {listLogs, readLogEntries, summarizeLog} from '../../core/log/llmLog.js';
import {formatBytes} from '../../utils/format.js';
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

  // Long raw transcripts page through $PAGER via suspendTerminal when the
  // interactive screen provides the affordance; the summary stays the default.
  if (viewRaw && ctx.viewInPager) {
    const entries = await readLogEntries(id);
    const text = entries.map(entry => JSON.stringify(entry)).join('\n');
    const paged = await ctx.viewInPager(text);
    if (!paged) ctx.addSystemMessage(`Log ${id} fits on screen; nothing paged.`);
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
