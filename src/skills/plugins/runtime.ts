import fs from 'node:fs/promises';
import {GLOBAL_PLUGINS_DIR} from '../../config/paths.js';
import {loadSkill} from '../SkillLoader.js';
import type {LoadedSkill, SkillRegistry} from '../types.js';
import {enumeratePlugins} from './installer.js';
import {canonicalRoot, localPath, readPluginManifest, safePath} from './package.js';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Installed receipts are the only activation authority; never discover caches or collections. */
export async function loadPluginSkills(errors: SkillRegistry['errors']): Promise<LoadedSkill[]> {
  const skills: LoadedSkill[] = [];
  let pluginsRoot: string;
  let plugins;
  try {
    pluginsRoot = await canonicalRoot(GLOBAL_PLUGINS_DIR);
    const enumeration = await enumeratePlugins();
    plugins = enumeration.plugins;
    for (const error of enumeration.errors) errors.push({...error, source: 'global'});
  } catch (error) {
    errors.push({directory: 'plugin-receipts', message: message(error)});
    return skills;
  }
  for (const plugin of plugins) {
    const directory = `${plugin.name}`;
    const report = (label: string, error: unknown): void => {
      errors.push({directory: `plugin:${directory}/${label}`, message: message(error)});
    };
    try {
      const root = await safePath(pluginsRoot, directory);
      const {manifest, format} = await readPluginManifest(root, plugin.name);
      if (manifest.name !== plugin.name) throw new Error('Installed plugin manifest name does not match receipt.');
      const names = new Set<string>();
      const visited = new Set<string>();
      async function loadDirectory(relative: string): Promise<void> {
        try {
          const dir = await safePath(root, relative);
          if (visited.has(dir)) return;
          visited.add(dir);
          if (!(await fs.stat(dir)).isDirectory()) return;
          const skill = await loadSkill(dir, 'global');
          if (!skill) return;
          const name = `${plugin.name}:${skill.name}`;
          if (names.has(name)) throw new Error(`duplicate skill name "${name}"; first valid skill wins`);
          names.add(name);
          skills.push({...skill, name, pluginName: plugin.name, pluginRoot: root});
        } catch (error) {
          if (!missing(error)) report(relative, error);
        }
      }
      // Each root is scanned only one level deep. Legacy paths may also name
      // an individual skill directory; neither case enables recursive discovery.
      async function loadRoot(relative: string, direct: boolean): Promise<void> {
        try {
          const dir = await safePath(root, relative);
          if (direct) {
            try {
              await fs.stat(await safePath(root, `${relative}/SKILL.md`));
              await loadDirectory(relative);
              return;
            } catch (error) { if (!missing(error)) throw error; }
          }
          for (const entry of (await fs.readdir(dir)).sort()) {
            await loadDirectory(`${relative}/${entry}`);
          }
        } catch (error) {
          if (!missing(error)) report(relative, error);
        }
      }
      await loadRoot('skills', false);
      // Portable manifests ignore overrides. Only Claude's legacy declaration
      // augments the default skills root, and every path remains package-local.
      if (format === 'claude' && manifest.skills !== undefined) {
        const custom = typeof manifest.skills === 'string' ? [manifest.skills] : manifest.skills;
        if (!Array.isArray(custom)) report('skills', new Error('Legacy skills must be a ./path string or string array.'));
        else for (const value of custom) {
          try {
            if (typeof value !== 'string' || !value.startsWith('./')) throw new Error('Legacy skills paths must start with ./ and stay inside the plugin.');
            await loadRoot(localPath(value), true);
          } catch (error) { report('skills', error); }
        }
      }
    } catch (error) { report('manifest', error); }
  }
  return skills;
}
