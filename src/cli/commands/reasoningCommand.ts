import {REASONING_LEVELS, REASONING_PROVIDER_DEFAULT, isReasoningLevel, isReasoningUnsetAlias, isStoredReasoning, resolveReasoningChoice, type ResolvedReasoningChoice, type StoredReasoningSetting} from '../../core/agent/reasoningPolicy.js';
import type {CommandContext, CommandResult} from './commands.js';

/**
 * `/reasoning` — per-model, per-session reasoning-effort picker and direct
 * set, modeled on `/themes`. The picker is one step in the `wizardFlow.ts`
 * table (mode `reasoning`); this module holds the pure result function shared
 * by the slash path and the wizard submit handler. The chosen level applies to
 * the active `provider:model` for the current session only — kept in memory on
 * the `PromptSession` object, never written to `~/.haze/settings.json` — and
 * applies from the next turn (reasoning is resolved once per attempt in
 * `attemptSetup`). A model without a session override falls back to the saved
 * global `reasoning` setting, then the built-in default.
 */

/** Picker value that stops sending a reasoning parameter (also accepted as `off` on the slash path). */
export const REASONING_UNSET = 'unset';

/** Picker/slash value that removes the session override and inherits the saved/default level. */
export const REASONING_RESET = 'reset';

const LEVELS_LIST = REASONING_LEVELS.join(', ');

export type ReasoningCommandResult =
  | {action: 'status'; message: string}
  | {action: 'set'; setting: StoredReasoningSetting; message: string}
  | {action: 'reset'; message: string}
  | {action: 'error'; message: string}
  | {action: 'open-picker'};

function describeChoice(choice: ResolvedReasoningChoice): string {
  if (choice.level === undefined) return 'provider default (no parameter sent)';
  if (choice.source === 'session') return `${choice.level} (session override)`;
  if (choice.source === 'settings') return `${choice.level} (from settings)`;
  return `${choice.level} (default)`;
}

/**
 * Resolve a `/reasoning` invocation against the current choice for the active
 * model. Pure: the caller applies `set`/`reset` to the session-scoped
 * per-model map (`PromptSession.reasoningByModel`); nothing touches settings.
 */
export function resolveReasoningCommand(args: string, input: {current: ResolvedReasoningChoice; stored: StoredReasoningSetting | undefined; modelSelector?: string}): ReasoningCommandResult {
  const value = args.trim().toLowerCase();
  const scope = input.modelSelector ? ` for ${input.modelSelector}` : '';
  if (!value) return {action: 'open-picker'};
  if (value === 'status') {
    return {action: 'status', message: `Reasoning effort${scope}: ${describeChoice(input.current)}. Set with /reasoning <level> (this model, this session), /reasoning unset to send no reasoning parameter, or /reasoning reset to fall back to the saved/default level. Levels: ${LEVELS_LIST}.`};
  }
  if (value === REASONING_RESET) {
    const fallback = resolveReasoningChoice(undefined, input.stored);
    return {action: 'reset', message: `Session reasoning override removed${scope}. ${describeChoice(fallback)} applies from the next turn.`};
  }
  if (isReasoningUnsetAlias(value)) {
    return {action: 'set', setting: REASONING_PROVIDER_DEFAULT, message: `Reasoning effort unset${scope}: no reasoning parameter is sent from the next turn; the provider default applies (this model, this session).`};
  }
  if (!isReasoningLevel(value)) {
    return {action: 'error', message: `Unknown reasoning level "${value}". Valid levels: ${LEVELS_LIST} — unset sends no reasoning parameter, reset falls back to the saved/default level.`};
  }
  return {action: 'set', setting: value, message: `Reasoning effort set to ${value}${scope}. Applies to this model for the current session; each model keeps its own level. Not written to ~/.haze/settings.json.`};
}

/** `provider:model` key for the settings-configured active model, or undefined when unconfigured. */
function activeModelSelector(context: {settings: {provider?: string; model?: string}}): string | undefined {
  const {provider, model} = context.settings;
  return provider && model ? `${provider}:${model}` : undefined;
}

export async function handleReasoningCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  const modelSelector = activeModelSelector(ctx);
  if (!args.trim()) {
    ctx.setMode('reasoning');
    ctx.addSystemMessage('Choose a reasoning effort level for the active model, for this session. unset sends no reasoning parameter (provider default); reset falls back to the saved or default level.');
    return 'handled';
  }
  if (!modelSelector) {
    ctx.addSystemMessage('No provider/model configured. /reasoning sets a per-model level; run /provider and /model first.');
    return 'handled';
  }
  const stored = isStoredReasoning(ctx.settings.reasoning) ? ctx.settings.reasoning : undefined;
  const current = resolveReasoningChoice(ctx.getSessionReasoning(modelSelector), stored);
  const result = resolveReasoningCommand(args, {current, stored, modelSelector});
  if (result.action === 'set') ctx.setSessionReasoning(modelSelector, result.setting);
  else if (result.action === 'reset') ctx.setSessionReasoning(modelSelector, undefined);
  // Unreachable (args are non-empty here) but narrows the open-picker variant away.
  if (result.action !== 'open-picker') ctx.addSystemMessage(result.message);
  return 'handled';
}
