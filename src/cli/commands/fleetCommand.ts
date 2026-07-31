import {SUBAGENT_MAX_CONCURRENCY} from '../../core/agent/budgets.js';
import type {TurnExecutionOptions} from './streaming.js';
import type {CommandContext, CommandResult} from './commands.js';

const FLEET_CONTROL = `This is an ephemeral /fleet parallel-only control. Decompose the durable request into genuinely independent, self-contained subagent capsules; decline if fewer than two exist and never invent tasks. For a repository-wide request, first do one bounded structure lookup, then give workers focused directory/file scope hints instead of all of src. Every call requires objective, deliverable, and mode; keep objective under 1000 characters, prefer at most 12 scope paths, and put output formatting in deliverable/acceptanceCriteria. Mode is inspect, research, implement, or validate. Never call subagent with {}. Runtime owns queueing, concurrency, deadlines, provider policy, and mutation serialization. Submit independent read-only calls together; submit mutation conservatively and validate after it settles. Aggregate every capsule truthfully by termination, usability, truncation, changed paths, validation, and coverage gaps. Retry a failed/limited worker at most once, only with materially narrower scope; otherwise report the gap. Never request private worker transcripts.`;

export interface ParsedFleetCommand {
  prompt: string;
  options: TurnExecutionOptions;
}

export function buildFleetPrompt(_args = ''): string { return FLEET_CONTROL; }

export function parseFleetArgs(args: string): {ok: true; value: ParsedFleetCommand} | {ok: false; error: string} {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const overrides: NonNullable<TurnExecutionOptions['subagentOverrides']> = {};
  let index = 0;
  while (index < tokens.length && tokens[index]!.startsWith('-')) {
    const flag = tokens[index++]!;
    if (flag === '--') break;
    if (flag === '--review') { overrides.forceMode = 'inspect'; continue; }
    if (!['--profile', '--workers', '--concurrency'].includes(flag)) return {ok: false, error: `Unknown /fleet flag: ${flag}`};
    const value = tokens[index++];
    if (!value || value.startsWith('--')) return {ok: false, error: `${flag} requires a value.`};
    if (flag === '--profile') overrides.profile = value;
    if (flag === '--workers') overrides.workerModel = value;
    if (flag === '--concurrency') {
      const concurrency = Number(value);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > SUBAGENT_MAX_CONCURRENCY) return {ok: false, error: `--concurrency must be an integer from 1 to ${SUBAGENT_MAX_CONCURRENCY}.`};
      overrides.maxConcurrency = concurrency;
    }
  }
  const prompt = tokens.slice(index).join(' ').trim();
  if (!prompt) return {ok: false, error: '/fleet needs a prompt describing parallel work.'};
  return {ok: true, value: {prompt, options: {ephemeralControl: FLEET_CONTROL, subagentOverrides: overrides}}};
}

const USAGE = '/fleet [--review] [--profile <name>] [--workers <provider:model>] [--concurrency <n>] [--] <prompt>';

export async function handleFleetCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  const parsed = parseFleetArgs(args);
  if (!parsed.ok) {
    ctx.addSystemMessage(`${parsed.error} Usage: ${USAGE}`);
    return 'handled';
  }
  const durable = `/fleet ${args.trim()}`;
  await ctx.runAgentTurn(durable, durable, parsed.value.options);
  return 'handled';
}
