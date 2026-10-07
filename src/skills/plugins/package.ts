import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {isProtectedSecretPath} from '../../core/safety/secretPaths.js';

export interface PluginManifest extends Record<string, unknown> {
  name: string;
  version?: string;
  description?: string;
}
export interface PluginInspection {
  root: string;
  manifest: PluginManifest;
  warnings: string[];
  /** Sorted package-relative regular file paths; no symlinks or secret files. */
  files: string[];
}
export const PLUGIN_LIMITS = {json: 256 * 1024, file: 4 * 1024 * 1024, total: 32 * 1024 * 1024, entries: 2000};

export function validatePluginName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(name) || /[^a-zA-Z0-9_.-]/.test(name) || name.includes('..')) throw new Error('Invalid plugin name. Use letters, numbers, hyphens, dots or underscores.');
}
export function localPath(value: string): string {
  if (!value || value.includes('\\') || value.includes('\0') || path.isAbsolute(value) || value.split('/').includes('..')) {
    throw new Error('Plugin path must be relative and cannot escape its root.');
  }
  return path.posix.normalize(value.replace(/^\.\//, ''));
}
/** Refuse symlinks in every existing ancestor, including the supplied root. */
export async function safePath(root: string, relative = ''): Promise<string> {
  const target = path.resolve(root, relative ? localPath(relative) : '.');
  const parts = target.slice(path.parse(target).root.length).split(path.sep);
  let current = path.parse(target).root;
  for (const part of parts) {
    current = path.join(current, part);
    if (isProtectedSecretPath(current)) throw new Error('Protected secret path in plugin package.');
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Symlinks are not allowed in plugin paths.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return target;
}
/**
 * Canonicalize host aliases (e.g. /var -> /private/var on macOS) in the
 * nearest existing ancestor of a root path; the final path segments are never
 * resolved, so a symlink at the root itself stays visible to safePath and is
 * refused. Mirrors the ancestor-only alias handling in inspectPlugin.
 */
export async function canonicalRoot(root: string): Promise<string> {
  try {
    const parent = await fs.realpath(path.dirname(root));
    return path.join(parent, path.basename(root));
  } catch {
    const parent = path.dirname(root);
    if (parent === root) return root;
    return path.join(await canonicalRoot(parent), path.basename(root));
  }
}

export async function boundedRead(file: string, limit = PLUGIN_LIMITS.file): Promise<Buffer> {
  await safePath(file);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Plugin file exceeds size limit or is not a regular file.');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let length = 0;
    while (length < buffer.length) {
      const {bytesRead} = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit || length > stat.size) throw new Error('Plugin file changed or exceeds size limit.');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a plugin JSON object.');
  return value as Record<string, unknown>;
}
export async function readJson(file: string): Promise<Record<string, unknown>> {
  return object(JSON.parse((await boundedRead(file, PLUGIN_LIMITS.json)).toString('utf8')));
}
async function exists(file: string): Promise<boolean> {
  await safePath(file);
  try { await fs.lstat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export interface PluginManifestRead {
  manifest: PluginManifest;
  warnings: string[];
  format: 'portable' | 'claude' | 'codex';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function hasStandardSkills(root: string): Promise<boolean> {
  const directory = await safePath(root, 'skills');
  try { return (await fs.lstat(directory)).isDirectory(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Read only the selected manifest; runtime loading must not walk unrelated components. */
export async function readPluginManifest(root: string, inferredName?: string): Promise<PluginManifestRead> {
  const locations = [
    ['plugin.json', 'portable'],
    ['.claude-plugin/plugin.json', 'claude'],
    ['.codex-plugin/plugin.json', 'codex'],
  ] as const;
  for (const [manifestPath, format] of locations) {
    const file = await safePath(root, manifestPath);
    if (!await exists(file)) continue;
    const raw = await readJson(file);
    const warnings: string[] = [];
    if (typeof raw.name !== 'string') throw new Error('Plugin manifest requires a name.');
    if (format === 'portable') {
      if (raw.$schema !== PLUGIN_SCHEMA) throw new Error(`Plugin $schema must be ${PLUGIN_SCHEMA}.`);
      if (raw.name.length > 64 || /[^a-z0-9.-]/.test(raw.name) || !/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(raw.name)) {
        throw new Error('Invalid portable plugin name: use 1–64 lowercase letters, numbers, hyphens or dots, starting and ending with a letter or number, without consecutive hyphens or dots.');
      }
    } else validatePluginName(raw.name);
    const stringFields = format === 'portable'
      ? ['version', 'description', 'homepage', 'repository', 'license']
      : ['version', 'description'];
    for (const key of stringFields) if (key in raw && typeof raw[key] !== 'string') throw new Error(`Plugin ${key} must be a string.`);
    if (format === 'portable') {
      if ('keywords' in raw && (!Array.isArray(raw.keywords) || raw.keywords.some(value => typeof value !== 'string'))) throw new Error('Plugin keywords must be an array of strings.');
      if ('author' in raw) {
        const author = object(raw.author);
        for (const key of Object.keys(author)) {
          if (!['name', 'email', 'url'].includes(key) || typeof author[key] !== 'string') throw new Error('Plugin author must contain only string name, email and url fields.');
        }
      }
    }
    const supported = new Set(['name', 'version', 'description', 'extensions', 'author', 'license', 'homepage', 'repository', 'keywords', '$schema']);
    if (format !== 'portable') supported.add('skills');
    const manifest: PluginManifest = {name: raw.name};
    for (const key of Object.keys(raw)) {
      if (!supported.has(key)) warnings.push(`Unsupported plugin field/component: ${key}; ignored.`);
      else if (key !== 'extensions') manifest[key] = raw[key];
    }
    if (format !== 'portable' && manifest.skills !== undefined) warnings.push('Declared legacy skills paths require explicit runtime resolution.');
    if ('extensions' in raw) {
      if (!isObject(raw.extensions)) warnings.push('Non-object plugin extensions; ignored.');
      else {
        const extensions: Record<string, unknown> = {};
        for (const key of Object.keys(raw.extensions)) {
          // Plugins install globally under ~/.haze and never write workspace
          // content, so no extension namespace (including dev.haze) activates.
          warnings.push(`Unsupported extension: ${key}; ignored.`);
        }
        manifest.extensions = extensions;
      }
    }
    return {manifest, warnings, format};
  }
  if (await hasStandardSkills(root)) {
    const name = inferredName ?? path.basename(path.resolve(root));
    validatePluginName(name);
    return {manifest: {name}, format: 'claude', warnings: [`No plugin manifest found; inferred Claude standard-layout plugin name: ${name}.`]};
  }
  throw new Error('No plugin.json, Claude or Codex plugin manifest found.');
}

export async function inspectPlugin(sourceDir: string, pluginName?: string): Promise<PluginInspection> {
  return inspectPluginAt(sourceDir, pluginName, 0);
}

async function inspectPluginAt(sourceDir: string, pluginName: string | undefined, collectionDepth: number): Promise<PluginInspection> {
  if (collectionDepth > 32) throw new Error('Plugin collection nesting exceeds limit.');
  if (/^[a-z][a-z0-9+.-]*:|^git@/i.test(sourceDir)) throw new Error('Remote plugins are not supported. Clone the repository locally, then install its local directory.');
  const source = path.resolve(sourceDir);
  if (isProtectedSecretPath(source)) throw new Error('Protected secret path in plugin package.');
  // Source roots may have host aliases (e.g. /var -> /private/var on macOS).
  // Package-relative paths below this canonical root still refuse all symlinks.
  const root = await safePath(await fs.realpath(source));
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Plugin source must be a directory.');
  const hasManifest = await exists(path.join(root, 'plugin.json')) || await exists(path.join(root, '.claude-plugin/plugin.json')) || await exists(path.join(root, '.codex-plugin/plugin.json'));
  if (hasManifest || await hasStandardSkills(root)) {
    const {manifest, warnings} = await readPluginManifest(root, pluginName);
    if (pluginName && manifest.name !== pluginName) throw new Error('Selected plugin does not match manifest name.');
    const files: string[] = [];
    let total = 0;
    let entries = 0;
    async function walk(relative: string, depth = 0): Promise<void> {
      if (depth > 32) throw new Error('Plugin directory nesting exceeds limit.');
      const directory = await fs.opendir(path.join(root, relative));
      for await (const entry of directory) {
        if (++entries > PLUGIN_LIMITS.entries) throw new Error('Plugin has too many entries.');
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        // Git metadata is not package content, and may contain credential URLs.
        if (entry.name === '.git') continue;
        const target = await safePath(root, name);
        if (entry.isDirectory()) await walk(name, depth + 1);
        else if (entry.isFile()) {
          const stat = await fs.stat(target);
          total += stat.size;
          if (stat.size > PLUGIN_LIMITS.file || total > PLUGIN_LIMITS.total) throw new Error('Plugin package exceeds size limits.');
          files.push(name);
        } else throw new Error('Plugin contains a symlink or special file.');
      }
    }
    await walk('');
    const unsupported = new Set(['mcp.json', '.mcp.json', '.lsp.json', 'hooks', 'agents', 'commands', 'rules', 'lsp']);
    const components = new Set(files.map(file => file.split('/')[0]).filter(component => unsupported.has(component)));
    for (const component of [...components].sort()) warnings.push(`Unsupported plugin component: ${component}; not activated.`);
    return {root, manifest, warnings, files: files.sort()};
  }
  for (const marketplacePath of ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json']) {
    const file = path.join(root, marketplacePath);
    if (!await exists(file)) continue;
    const marketplace = await readJson(file);
    if (!pluginName) throw new Error('This is a plugin collection; select a plugin name.');
    validatePluginName(pluginName);
    if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length > PLUGIN_LIMITS.entries) throw new Error('Invalid marketplace plugins list.');
    const matches = marketplace.plugins.map(object).filter(entry => entry.name === pluginName);
    if (matches.length !== 1) throw new Error('Selected plugin must occur exactly once in the collection.');
    const entry = matches[0];
    let source: unknown = entry.source;
    if (source && typeof source === 'object') {
      const local = object(source);
      if (local.source !== 'local') throw new Error('Remote plugins are not supported. Clone the repository locally first.');
      source = local.path;
    } else if (source === 'local') source = entry.path;
    if (typeof source !== 'string' || !source.startsWith('./')) throw new Error('Collection sources must be local ./paths. Clone remote repositories locally first.');
    const relative = localPath(source);
    if (!relative || relative === '.') throw new Error('Collection plugin source cannot point at the collection root.');
    return inspectPluginAt(await safePath(root, relative), pluginName, collectionDepth + 1);
  }
  throw new Error('No plugin.json, Claude or Codex plugin manifest found.');
}
