import type React from 'react';
import {listSessions, type SessionSummary} from '../../core/session/sessionStore.js';
import {MAX_SESSION_PICKER_RESULTS} from '../commands/sessionPicker.js';
import {listInstalledPlugins} from '../commands/pluginCommand.js';
import type {Mode} from '../commands/chatModes.js';
import type {Message} from '../commands/streaming.js';
import type {WizardUiAction} from './wizardDispatch.js';

export type PickerOpenerDeps = {
  /** Flushes the active session before listing so it is visible to the picker. */
  flush: () => Promise<unknown>;
  onFlushError: (error: unknown) => void;
  setSessions: (sessions: SessionSummary[]) => void;
  updateWizard: (action: WizardUiAction) => void;
  setMode: (mode: Mode) => void;
  setMessages: (updater: React.SetStateAction<Message[]>) => void;
};

/**
 * Openers for the session and plugin pickers, extracted from `ChatScreen`
 * (ARCH-05). They only load data and route to the matching mode; the picker
 * submit handling stays in `wizardDispatch.ts`.
 */
export function createPickerOpeners(deps: PickerOpenerDeps) {
  async function openSessionPicker() {
    await deps.flush().catch(deps.onFlushError);
    const next = await listSessions();
    deps.setSessions(next);
    deps.updateWizard({type: 'set', key: 'selectedSessionId', value: undefined});
    if (next.length === 0) {
      deps.setMessages(m => [...m, {role: 'system', text: 'No saved sessions found for this workspace.'}]);
      deps.setMode('chat');
      return;
    }
    deps.setMode('sessions');
    const hidden = Math.max(0, next.length - MAX_SESSION_PICKER_RESULTS);
    deps.setMessages(m => [...m, {role: 'system', text: `Choose a saved session (newest first)${hidden ? `. Showing ${MAX_SESSION_PICKER_RESULTS} of ${next.length}; ${hidden} older sessions are hidden.` : '.'}`}]);
  }

  async function openPluginPicker() {
    try {
      deps.updateWizard({type: 'plugins', value: await listInstalledPlugins()});
    } catch (error) {
      deps.setMessages(m => [...m, {role: 'system', text: `Could not list installed plugins: ${error instanceof Error ? error.message : String(error)}`}]);
      return;
    }
    deps.setMode('plugins');
    deps.setMessages(m => [...m, {role: 'system', text: 'Choose install plugin, inspect plugin, or an installed plugin to manage. Only skills activate; no scripts, hooks, or MCP servers run.'}]);
  }

  return {openSessionPicker, openPluginPicker};
}
