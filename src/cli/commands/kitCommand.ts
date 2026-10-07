import {inspectKit, installKit, listKits, removeKit} from '../../skills/kits.js';
import type {CommandContext, CommandResult} from './commands.js';

export const KIT_USAGE = '/kit [list | inspect <local-kit-directory> | install <local-kit-directory> | remove <kit-id>]';

export async function runKitAction(action = 'list', target?: string): Promise<string> {
  if (action === 'list' && !target) return listKits();
  if (action === 'inspect' && target) return inspectKit(target);
  if (action === 'install' && target) return installKit(target);
  if (action === 'remove' && target) return removeKit(target);
  throw new Error(`Usage: ${KIT_USAGE}. Local directories only; review a source before installing it.`);
}

export async function handleKitCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(args.trim());
  const action = match?.[1] ?? 'list';
  let target = match?.[2]?.trim();
  if (target && ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'")))) target = target.slice(1, -1);
  ctx.addSystemMessage(await runKitAction(action, target));
  if (action === 'install' || action === 'remove') await ctx.refreshSkills?.();
  return 'handled';
}
