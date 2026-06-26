import {listLogs, readLogEntries} from '../../core/log/llmLog.js';
import type {CommandContext, CommandResult} from './commands.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function handleLogsCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  const id = args.trim();

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

  const entries = await readLogEntries(id);
  if (entries.length === 0) {
    ctx.addSystemMessage(`No log found with id ${id}.`);
    return 'handled';
  }

  const typeCounts: Record<string, number> = {};
  let totalInput = 0;
  let totalOutput = 0;
  const toolCallCounts: Record<string, number> = {};

  for (const entry of entries) {
    typeCounts[entry.type] = (typeCounts[entry.type] ?? 0) + 1;
    if (entry.usage) {
      totalInput += entry.usage.inputTokens ?? 0;
      totalOutput += entry.usage.outputTokens ?? 0;
    }
    if (entry.type === 'tool_call' && entry.toolCall) {
      toolCallCounts[entry.toolCall.name] = (toolCallCounts[entry.toolCall.name] ?? 0) + 1;
    }
  }

  const typeLines = Object.entries(typeCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `  ${type}: ${count}`);

  const toolLines = Object.entries(toolCallCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `  ${name}: ${count}`);

  const parts = [
    `Log: ${id}`,
    `Entries: ${entries.length}`,
    '',
    'Entry counts by type:',
    ...typeLines,
    '',
    `Total token usage: in=${totalInput} out=${totalOutput}`,
  ];

  if (toolLines.length > 0) {
    parts.push('', 'Tool call counts:', ...toolLines);
  }

  ctx.addSystemMessage(parts.join('\n'));
  return 'handled';
}
