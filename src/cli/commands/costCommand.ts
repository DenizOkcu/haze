import {readUsageEntries, readUsageRange, getCorruptedLedgerFiles, clearCorruptedLedgerFiles, type UsageLedgerEntry} from '../../core/usage/usageLedger.js';
import {formatTokenCount} from '../chat/chatMetrics.js';
import type {CommandContext, CommandResult} from './commands.js';

interface Aggregate {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  cost: number;
  priced: boolean;
}

function emptyAggregate(): Aggregate {
  return {inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0, priced: false};
}

function addEntry(agg: Aggregate, entry: UsageLedgerEntry): Aggregate {
  agg.inputTokens += entry.inputTokens;
  agg.outputTokens += entry.outputTokens;
  agg.cacheReadTokens += entry.cacheReadTokens;
  agg.cacheWriteTokens += entry.cacheWriteTokens;
  agg.reasoningTokens += entry.reasoningTokens;
  if (entry.cost != null) {
    agg.cost += entry.cost;
    agg.priced = true;
  }
  return agg;
}

function aggregateEntries(entries: UsageLedgerEntry[]) {
  const total = emptyAggregate();
  const byKey = new Map<string, Aggregate>();
  for (const entry of entries) {
    addEntry(total, entry);
    const key = `${entry.provider}:${entry.model}`;
    const existing = byKey.get(key) ?? emptyAggregate();
    byKey.set(key, addEntry(existing, entry));
  }
  return {total, byKey};
}

function formatCompact(agg: Aggregate): string {
  const cost = agg.priced ? `  ~$${agg.cost.toFixed(4)}` : '';
  return `↑${formatTokenCount(agg.inputTokens)} ↓${formatTokenCount(agg.outputTokens)}${cost}`;
}

function modelRows(byKey: Map<string, Aggregate>): string[] {
  return [...byKey.entries()]
    .sort((a, b) => b[1].cost - a[1].cost || b[1].inputTokens - a[1].inputTokens)
    .map(([key, agg]) => `  ${key.padEnd(32)} ${formatCompact(agg)}`);
}

export async function handleCostCommand(
  args: string,
  ctx: CommandContext,
  options?: {baseDir?: string},
): Promise<CommandResult> {
  clearCorruptedLedgerFiles();
  const scope = args.trim().toLowerCase();
  const now = new Date();

  const sessionEntries = ctx.sessionStart
    ? (await readUsageRange(1, {now, baseDir: options?.baseDir}))
        .filter(e => e.sessionStart === ctx.sessionStart!.toISOString())
    : [];
  const todayEntries = await readUsageEntries({date: now, baseDir: options?.baseDir});
  const weekEntries = await readUsageRange(7, {now, baseDir: options?.baseDir});

  const sessionAgg = aggregateEntries(sessionEntries);
  const todayAgg = aggregateEntries(todayEntries);
  const weekAgg = aggregateEntries(weekEntries);

  const lines: string[] = ['Usage / cost'];
  if (scope === '' || scope === 'session') {
    if (ctx.sessionStart) {
      lines.push('', `Session (${ctx.sessionStart.toISOString().slice(0, 19).replace('T', ' ')})`);
      lines.push(`  ${formatCompact(sessionAgg.total)}`);
      lines.push(...modelRows(sessionAgg.byKey));
    } else {
      lines.push('', 'Session view is only available inside an interactive chat session.');
    }
  }
  if (scope === '' || scope === 'today') {
    lines.push('', `Today (${now.toISOString().slice(0, 10)})`);
    lines.push(`  ${formatCompact(todayAgg.total)}`);
    lines.push(...modelRows(todayAgg.byKey));
  }
  if (scope === '' || scope === 'week') {
    lines.push('', 'Last 7 days');
    lines.push(`  ${formatCompact(weekAgg.total)}`);
    lines.push(...modelRows(weekAgg.byKey));
  }

  const corrupted = getCorruptedLedgerFiles();
  if (corrupted.length) {
    lines.push('', `Warning: ${corrupted.length} usage ledger file(s) contained corrupted lines and were partially skipped.`);
  }

  ctx.addSystemMessage(lines.join('\n'));
  return 'handled';
}
