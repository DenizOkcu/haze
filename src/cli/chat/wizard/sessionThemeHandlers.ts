import type {Mode} from '../../commands/chatModes.js';
import {selectThemeResult} from '../../commands/themesCommand.js';
import {SESSION_ACTIONS} from '../../commands/sessionPicker.js';
import type {WizardDispatchDeps, WizardHandler, WizardSetterContext} from './types.js';

/** Session picker and theme picker handlers (both tiny single-purpose flows). */
export function createSessionThemeHandlers(deps: WizardDispatchDeps, ctx: WizardSetterContext): Partial<Record<Mode, WizardHandler>> {
  const {setMode, showMessage} = ctx;
  const setSelectedSessionId = ctx.setSelectedSessionId;

  async function selectSession(id: string) {
    if (!deps.sessions?.some(session => session.id === id)) {
      showMessage(`No session named ${id} exists for this workspace.`);
      setMode('chat');
      return;
    }
    setSelectedSessionId(id);
    setMode('sessionAction');
    showMessage(`Session ${id}: press Enter to resume, or choose fork.`);
  }

  async function selectSessionAction(action: string) {
    const id = deps.wizard.selectedSessionId;
    if (!id) {
      showMessage('No session selected. Start over with /resume.');
      setMode('chat');
      return;
    }
    if (action === SESSION_ACTIONS.resume) await deps.resumeSessionById?.(id);
    else if (action === SESSION_ACTIONS.fork) await deps.forkSessionById?.(id);
    else {
      showMessage(`Unknown session action: ${action}.`);
      return;
    }
    setSelectedSessionId(undefined);
    setMode('chat');
  }

  async function selectTheme(name: string) {
    const result = selectThemeResult(name);
    if (result.settingsPatch) {
      await ctx.applySettings(result.settingsPatch);
      setMode('chat');
    }
    showMessage(result.message);
  }

  return {
    sessions: selectSession,
    sessionAction: selectSessionAction,
    themes: selectTheme,
  };
}
