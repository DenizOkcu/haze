import {resolveTheme} from '../../ui/theme.js';
import type {HazeSettings} from '../../config/settings.js';
import type {CommandContext, CommandResult} from './commands.js';

/**
 * `/themes` — theme picker and direct set. The picker is one step in the
 * `wizardFlow.ts` table (mode `themes`); this module holds the pure selection
 * result shared by the slash path and the wizard submit handler, mirroring the
 * other `*Command.ts` / `*Wizard.ts` splits. Applying the resolved theme live
 * is owned by ChatScreen (it re-resolves whenever `settings.theme` changes).
 */
export interface ThemeSelectionResult {
  /** Present when the name is valid and should be persisted; absent means the message explains the failure. */
  settingsPatch?: HazeSettings;
  message: string;
}

/** Validate a theme name against the built-in registry (`resolveTheme` lists the valid names on failure) and shape the persist result. */
export function selectThemeResult(name: string): ThemeSelectionResult {
  const trimmed = name.trim();
  try {
    resolveTheme(trimmed);
  } catch (error) {
    return {message: error instanceof Error ? error.message : String(error)};
  }
  return {settingsPatch: {theme: trimmed}, message: `Theme set to ${trimmed}. Saved to ~/.haze/settings.json. Text already on screen keeps its old colors.`};
}

export async function handleThemesCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  if (!args) {
    ctx.setMode('themes');
    ctx.addSystemMessage('Choose a theme. Selecting one applies it immediately and saves it to ~/.haze/settings.json.');
    return 'handled';
  }
  const result = selectThemeResult(args);
  if (result.settingsPatch) await ctx.updateSettings(result.settingsPatch);
  ctx.addSystemMessage(result.message);
  return 'handled';
}
