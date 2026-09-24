import {DEFAULT_REASONING_LEVEL, REASONING_LEVELS, REASONING_PROVIDER_DEFAULT, isReasoningLevel, isReasoningUnsetAlias} from '../../core/agent/reasoningPolicy.js';
import type {HazeSettings} from '../../config/settings.js';
import type {CommandContext, CommandResult} from './commands.js';

/**
 * `/reasoning` — reasoning-effort picker and direct set, modeled on
 * `/themes`. The picker is one step in the `wizardFlow.ts` table (mode
 * `reasoning`); this module holds the pure result function shared by the
 * slash path and the wizard submit handler. The setting applies from the next
 * turn (reasoning is resolved once per attempt in `attemptSetup`).
 */

/** Picker value that clears the setting (also accepted as `off` on the slash path). */
export const REASONING_UNSET = 'unset';

const LEVELS_LIST = REASONING_LEVELS.join(', ');

export type ReasoningCommandResult =
  | {action: 'status'; message: string}
  | {action: 'set'; settingsPatch: HazeSettings; message: string}
  | {action: 'clear'; settingsPatch: HazeSettings; message: string}
  | {action: 'error'; message: string}
  | {action: 'open-picker'};

/**
 * Resolve a `/reasoning` invocation against the current setting. Pure: the
 * caller applies `settingsPatch` (a `reasoning: undefined` clear drops the
 * key, because settings writes serialize with `JSON.stringify`).
 */
export function resolveReasoningCommand(args: string, current: unknown): ReasoningCommandResult {
  const value = args.trim().toLowerCase();
  if (!value) return {action: 'open-picker'};
  if (value === 'status') {
    const level = isReasoningLevel(current) ? current : DEFAULT_REASONING_LEVEL;
    return {action: 'status', message: `Reasoning effort: ${level}${current === level ? '' : ` (default ${DEFAULT_REASONING_LEVEL})`}. Sent as the model's reasoning parameter. Change with /reasoning <level>, /reasoning unset for the provider default, or /reasoning none to turn reasoning off. Levels: ${LEVELS_LIST}.`};
  }
  if (isReasoningUnsetAlias(value)) {
    return {action: 'clear', settingsPatch: {reasoning: REASONING_PROVIDER_DEFAULT}, message: `Reasoning effort unset. No reasoning parameter is sent from the next turn; the provider default applies.`};
  }
  if (!isReasoningLevel(value)) {
    return {action: 'error', message: `Unknown reasoning level "${value}". Valid levels: ${LEVELS_LIST} — or ${REASONING_UNSET} for the provider default.`};
  }
  return {action: 'set', settingsPatch: {reasoning: value}, message: `Reasoning effort set to ${value}. Saved to ~/.haze/settings.json; applies from the next turn. Endpoints without native support ignore the parameter.`};
}

export async function handleReasoningCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  if (!args.trim()) {
    ctx.setMode('reasoning');
    ctx.addSystemMessage('Choose a reasoning effort level. Selecting one saves it to ~/.haze/settings.json and applies from the next turn; unset sends no reasoning parameter (provider default).');
    return 'handled';
  }
  const result = resolveReasoningCommand(args, ctx.settings.reasoning);
  if (result.action === 'set' || result.action === 'clear') await ctx.updateSettings(result.settingsPatch);
  // Unreachable (args are non-empty here) but narrows the open-picker variant away.
  if (result.action !== 'open-picker') ctx.addSystemMessage(result.message);
  return 'handled';
}
