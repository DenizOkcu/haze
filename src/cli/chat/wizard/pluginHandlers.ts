import path from 'node:path';
import os from 'node:os';
import {listInstalledPlugins, pluginCollectionEntries, runPluginCommand} from '../../commands/pluginCommand.js';
import {PLUGIN_ACTIONS, PLUGIN_CHOICES} from '../../commands/wizardFlow.js';
import type {Mode} from '../../commands/chatModes.js';
import {confirmRemoveStep, type WizardDispatchDeps, type WizardHandler, type WizardSetterContext} from './types.js';

/**
 * `/plugin` picker handlers, mirroring the LSP/MCP wizard shape: the root
 * picker (install/inspect/installed), per-plugin actions, source-directory
 * input steps, collection-entry pickers, and the typed-"yes" confirm-remove.
 * The heavy lifting stays in `pluginCommand.ts` (`runPluginCommand`), so the
 * headless and interactive paths share one implementation.
 */
export function createPluginWizardHandlers(deps: WizardDispatchDeps, ctx: WizardSetterContext): Partial<Record<Mode, WizardHandler>> {
  const {setMode, showMessage} = ctx;
  const setSelectedPluginName = ctx.setSelectedPluginName;
  const setPluginSourceDir = ctx.setPluginSourceDir;
  const runner = deps.pluginRunner ?? {
    install: async (source: string, name: string | undefined) => runPluginCommand(['install', source, ...(name ? [name] : [])]),
    inspect: async (source: string, name: string | undefined) => runPluginCommand(['inspect', source, ...(name ? [name] : [])]),
    remove: async (name: string) => runPluginCommand(['remove', name]),
    collection: pluginCollectionEntries,
  };

  async function reloadPlugins() {
    try {
      ctx.setPlugins(await listInstalledPlugins());
    } catch (error) {
      showMessage(`Could not list installed plugins: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Run one plugin action, surface its message or failure, and return to chat; reload list + skills after installs. */
  async function settle(action: Promise<string>, installed: boolean) {
    try {
      showMessage(await action);
    } catch (error) {
      showMessage(error instanceof Error ? error.message : String(error));
    }
    if (installed) {
      await reloadPlugins();
      await deps.refreshSkills();
    }
    setMode('chat');
  }

  async function selectPlugin(value: string) {
    if (value === PLUGIN_CHOICES.installPlugin) {
      setPluginSourceDir(undefined);
      ctx.setPluginCollectionEntries([]);
      setMode('pluginInstallSource');
      showMessage('Local plugin directory to install? Relative paths resolve from the workspace; quote paths with spaces. Clone remote repositories locally first.');
      return;
    }
    if (value === PLUGIN_CHOICES.inspectPlugin) {
      setPluginSourceDir(undefined);
      ctx.setPluginCollectionEntries([]);
      setMode('pluginInspectSource');
      showMessage('Local plugin directory to inspect? Only skills are activated on install; review source first.');
      return;
    }
    if (!deps.wizard.plugins.some(plugin => plugin.name === value)) {
      showMessage(`No installed plugin named ${value}. Choose install plugin, inspect plugin, or an installed plugin.`);
      return;
    }
    setSelectedPluginName(value);
    setMode('pluginAction');
    showMessage(`Plugin ${value}: choose an action.`);
  }

  /** Shared source-directory submit: install or inspect, with collection branching. */
  async function submitSource(kind: 'install' | 'inspect', source: string) {
    const trimmed = source.trim();
    if (!trimmed) {
      showMessage('Plugin directory is required. Enter a local path, or press ESC to cancel.');
      return;
    }
    try {
      // A collection: offer its entries instead of acting on the root. Root
      // manifests keep precedence, exactly like runPluginCommand('inspect').
      const entries = await runner.collection(trimmed);
      setPluginSourceDir(trimmed);
      ctx.setPluginCollectionEntries(entries);
      setMode(kind === 'install' ? 'pluginInstallName' : 'pluginInspectName');
      showMessage(`Plugin collection: choose an entry to ${kind}.`);
      return;
    } catch {
      // Not a collection (or unreadable as one): act on the directory itself.
    }
    await settle(kind === 'install' ? runner.install(trimmed, undefined) : runner.inspect(trimmed, undefined), kind === 'install');
  }

  async function submitCollectionEntry(kind: 'install' | 'inspect', name: string) {
    const source = deps.wizard.pluginSourceDir;
    if (!source || !deps.wizard.pluginCollectionEntries.some(entry => entry.name === name)) {
      showMessage('No plugin source selected. Start over with /plugin.');
      setMode('chat');
      return;
    }
    await settle(kind === 'install' ? runner.install(source, name) : runner.inspect(source, name), kind === 'install');
    setPluginSourceDir(undefined);
    ctx.setPluginCollectionEntries([]);
  }

  async function selectPluginAction(action: string) {
    const name = deps.wizard.selectedPluginName;
    if (!name) {
      showMessage('No plugin selected. Start over with /plugin.');
      setMode('chat');
      return;
    }
    if (action === PLUGIN_ACTIONS.showInfo) {
      // The installed copy under ~/.haze/plugins keeps the package manifest, so
      // inspecting it shows the real summary; the list output stays the
      // fallback for skills-only layouts.
      try {
        showMessage(await runner.inspect(path.join(os.homedir(), '.haze', 'plugins', name), name));
        setMode('chat');
      } catch {
        await settle(listSummary(), false);
      }
      return;
    }
    if (action === PLUGIN_ACTIONS.removePlugin) {
      setMode('pluginConfirmRemove');
      showMessage(`Remove plugin ${name}? Modified and unowned files are preserved. Type "yes" to confirm.`);
      return;
    }
    showMessage(`Unknown plugin action: ${action}.`);
  }

  async function listSummary(): Promise<string> {
    try {
      return await runPluginCommand(['list']);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  const pluginConfirmRemoveMode = confirmRemoveStep(ctx, {
    selectedName: () => deps.wizard.selectedPluginName,
    cancelMessage: 'Cancelled. Plugin not removed.',
    clearSelection: () => setSelectedPluginName(undefined),
    remove: async name => {
      const message = await runner.remove(name);
      await reloadPlugins();
      await deps.refreshSkills();
      return message;
    },
  });

  return {
    plugins: selectPlugin,
    pluginAction: selectPluginAction,
    pluginInstallSource: (value: string) => submitSource('install', value),
    pluginInspectSource: (value: string) => submitSource('inspect', value),
    pluginInstallName: (value: string) => submitCollectionEntry('install', value),
    pluginInspectName: (value: string) => submitCollectionEntry('inspect', value),
    pluginConfirmRemove: pluginConfirmRemoveMode,
  };
}
