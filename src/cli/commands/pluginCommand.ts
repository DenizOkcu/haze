import fs from 'node:fs/promises';
import path from 'node:path';
import {inspectPlugin, PLUGIN_LIMITS, readJson, safePath} from '../../skills/plugins/package.js';
import {installPlugin, listPlugins, removePlugin} from '../../skills/plugins/installer.js';
import type {CommandContext, CommandResult} from './commands.js';

export const PLUGIN_HELP = 'plugin inspect <local-directory> [plugin-name]\nplugin install <local-directory> [plugin-name]\nplugin list\nplugin remove <name>\nPlugins install globally under ~/.haze/plugins and never write workspace content. Installation trusts local instruction content; no scripts, hooks or MCP servers are activated. Clone remote collections locally first. kit is an alias for plugin.';

async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Installed plugins for the `/plugin` picker (receipt-listed, global ~/.haze). */
export async function listInstalledPlugins(): Promise<{name: string; version?: string}[]> {
  return listPlugins();
}

/** Collection entries from a local marketplace root; throws when the directory is not a collection (root plugin manifests keep precedence). */
export async function pluginCollectionEntries(source: string): Promise<{name: string; description?: string}[]> {
  const root = await safePath(await fs.realpath(path.resolve(source)));
  // Root plugin manifests keep precedence over colocated marketplace catalogs.
  for (const manifest of ['plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'skills']) {
    if (await exists(await safePath(root, manifest))) throw new Error('Not a plugin collection.');
  }
  const {plugins} = await readCollection(root);
  return plugins.map(entry => {
    const record = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    if (typeof record.name !== 'string' || !record.name) throw new Error('Invalid marketplace plugin entry.');
    return {name: record.name, ...(typeof record.description === 'string' ? {description: record.description} : {})};
  });
}

/** Read and validate a marketplace catalog (`.claude-plugin` first, then `.agents/plugins`). */
async function readCollection(source: string): Promise<{name?: string; plugins: unknown[]}> {
  const root = await safePath(await fs.realpath(path.resolve(source)));
  for (const location of ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json']) {
    const file = await safePath(root, location);
    try { await fs.lstat(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const catalog = await readJson(file);
    if (!Array.isArray(catalog.plugins) || catalog.plugins.length > PLUGIN_LIMITS.entries) throw new Error('Invalid marketplace plugins list.');
    return {name: typeof catalog.name === 'string' ? catalog.name : undefined, plugins: catalog.plugins};
  }
  throw new Error('No plugin collection marketplace found.');
}

/** cwd is kept for source-path resolution symmetry with other commands; installs are global. */
export async function runPluginCommand(args: string[], _cwd = process.cwd()): Promise<string> {
  const [action, source, name, ...extra] = args;
  if (!action || action === 'help') return PLUGIN_HELP;
  if (extra.length || (action === 'list' && source) || (action === 'remove' && name)) throw new Error(PLUGIN_HELP);
  if (action === 'list') {
    const installed = await listPlugins();
    return installed.length ? installed.map(plugin => `${plugin.name}${plugin.version ? `@${plugin.version}` : ''}`).join('\n') : 'No plugins installed.';
  }
  if (!source) throw new Error(PLUGIN_HELP);
  if (action === 'remove') {
    const result = await removePlugin(source);
    return `Removed plugin ${result.name}.${result.retained.length ? `\nRetained modified/unowned files:\n${result.retained.join('\n')}` : ''}`;
  }
  if (action === 'install') {
    const result = await installPlugin(source, name);
    return `${result.alreadyInstalled ? 'Plugin already installed:' : 'Installed'} ${result.name}${result.version ? `@${result.version}` : ''}.\nUse /skills or /${result.name}:<skill-name>.${result.warnings.length ? `\n${result.warnings.join('\n')}` : ''}`;
  }
  if (action === 'inspect') {
    let result;
    try { result = await inspectPlugin(source, name); } catch (error) {
      if (!(error instanceof Error) || error.message !== 'This is a plugin collection; select a plugin name.') throw error;
      // Collection inspection lists metadata only; selection is required to install.
      const catalog = await readCollection(source).catch(() => undefined);
      if (!catalog) throw error;
      const entries = await pluginCollectionEntries(source);
      const collectionName = catalog.name ?? path.basename(await fs.realpath(path.resolve(source)));
      return `Plugin collection: ${collectionName}\n${entries.map(entry => entry.name).join('\n')}\nSelect one: plugin inspect <local-directory> <plugin-name>`;
    }
    const skills = result.files.filter(file => /^skills\/[^/]+\/SKILL\.md$/.test(file));
    return `${result.manifest.name}${result.manifest.version ? `@${result.manifest.version}` : ''}\n${result.manifest.description ?? ''}\n${skills.length} standard skills; ${result.files.length} package files.${result.warnings.length ? `\n${result.warnings.join('\n')}` : ''}`;
  }
  throw new Error(PLUGIN_HELP);
}

/** Quoted local paths work in chat too; this is argument parsing, not shell execution. */
export function pluginCommandParts(value: string): string[] {
  const parts: string[] = [];
  let remaining = value.trim();
  while (remaining) {
    const match = /^(?:"([^"]*)"|'([^']*)'|([^\s"']+))(?:\s+|$)/.exec(remaining);
    if (!match) throw new Error('Invalid plugin arguments. Quote paths containing spaces.');
    parts.push(match[1] ?? match[2] ?? match[3]);
    remaining = remaining.slice(match[0].length);
  }
  return parts;
}

export async function handlePluginCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  const parts = pluginCommandParts(args);
  if (parts.length === 0) {
    // Bare `/plugin` opens the picker, consistent with /skills, /lsp, and /mcp;
    // headless contexts without a picker keep the usage text.
    if (ctx.openPluginPicker) await ctx.openPluginPicker();
    else ctx.addSystemMessage(PLUGIN_HELP);
    return 'handled';
  }
  ctx.addSystemMessage(await runPluginCommand(parts));
  if (parts[0] === 'install' || parts[0] === 'remove') await ctx.refreshSkills?.();
  return 'handled';
}
