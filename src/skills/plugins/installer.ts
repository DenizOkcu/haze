import fs from 'node:fs/promises';
import {Stats} from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {HAZE_DIR} from '../../config/paths.js';
import {boundedRead, canonicalRoot, inspectPlugin, localPath, object, PLUGIN_LIMITS, readJson, safePath, validatePluginName} from './package.js';

interface OwnedFile {path: string; sha256: string; mode: 'package'; executable: boolean}
interface Receipt {name: string; version?: string; files: OwnedFile[]}
export interface PluginInstallResult {name: string; version?: string; alreadyInstalled: boolean; warnings: string[]}
export interface InstalledPlugin {name: string; version?: string}
export interface PluginEnumeration {plugins: InstalledPlugin[]; errors: {directory: string; message: string}[]}
export interface PluginRemoveResult {name: string; retained: string[]}
const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

// Host aliases in ~/.haze ancestors (e.g. /var -> /private/var on macOS) are
// canonicalized once per operation; package-relative paths below the roots
// still refuse all symlinks through safePath.
const pluginsHome = (): Promise<string> => canonicalRoot(path.join(HAZE_DIR, 'plugins'));
const receiptsHome = (): Promise<string> => canonicalRoot(path.join(HAZE_DIR, 'plugin-receipts'));

async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
/** Receipts always live in the user's global ~/.haze, never in a workspace. */
async function receipt(receiptsRoot: string, name: string): Promise<Receipt | undefined> {
  const file = await safePath(receiptsRoot, `${name}.json`);
  if (!await exists(file)) return undefined;
  const raw = await readJson(file);
  if (raw.name !== name || (raw.version !== undefined && typeof raw.version !== 'string') || !Array.isArray(raw.files) || raw.files.length > PLUGIN_LIMITS.entries + 100) throw new Error('Invalid plugin receipt.');
  const seen = new Set<string>();
  const files = raw.files.map(value => {
    const entry = object(value);
    if (typeof entry.path !== 'string' || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || typeof entry.executable !== 'boolean' || entry.mode !== 'package') throw new Error('Invalid plugin receipt file.');
    const relative = localPath(entry.path);
    if (!relative.startsWith(`plugins/${name}/`)) throw new Error('Invalid receipt ownership path.');
    if (seen.has(relative)) throw new Error('Duplicate receipt ownership path.');
    seen.add(relative);
    return {path: relative, sha256: entry.sha256, mode: 'package' as const, executable: entry.executable};
  });
  return {name, version: raw.version as string | undefined, files};
}
async function withLock<T>(receiptsRoot: string, action: () => Promise<T>): Promise<T> {
  await fs.mkdir(receiptsRoot, {recursive: true});
  const lock = await safePath(receiptsRoot, '.lock');
  let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Plugin operation is locked. Wait for the other operation; if interrupted, remove the stale ${lock} manually.`, {cause: error});
    throw error;
  }
  try { return await action(); } finally { await handle.close(); await fs.unlink(lock); }
}
async function currentHash(pluginsRoot: string, entry: OwnedFile): Promise<string | undefined> {
  const target = await safePath(pluginsRoot, entry.path.slice('plugins/'.length));
  if (!await exists(target)) return undefined;
  return hash(await boundedRead(target));
}
async function prune(pluginsRoot: string, relative: string): Promise<void> {
  // Remove only empty directories, never recurse over potentially user-owned data.
  let parent = path.posix.dirname(relative);
  while (parent !== '.' && parent !== 'plugins') {
    try { await fs.rmdir(await safePath(pluginsRoot, parent.slice('plugins/'.length))); } catch { break; }
    parent = path.posix.dirname(parent);
  }
}
const pluginTarget = (pluginsRoot: string, entry: OwnedFile): Promise<string> => safePath(pluginsRoot, entry.path.slice('plugins/'.length));

export async function installPlugin(sourceDir: string, pluginName?: string): Promise<PluginInstallResult> {
  const inspected = await inspectPlugin(sourceDir, pluginName);
  const {name, version} = inspected.manifest;
  const pluginsRoot = await pluginsHome();
  const receiptsRoot = await receiptsHome();
  return withLock(receiptsRoot, async () => {
    const warnings = [...inspected.warnings];
    const pending: {entry: OwnedFile; data: Buffer}[] = [];
    let totalBytes = 0;
    for (const file of inspected.files) {
      const source = await safePath(inspected.root, file);
      const data = await boundedRead(source);
      const executable = ((await fs.stat(source)).mode & 0o111) !== 0;
      totalBytes += data.length;
      if (totalBytes > PLUGIN_LIMITS.total) throw new Error('Plugin package exceeds aggregate size limit.');
      pending.push({entry: {path: `plugins/${name}/${file}`, sha256: hash(data), mode: 'package', executable}, data});
    }
    const prior = await receipt(receiptsRoot, name);
    if (prior) {
      if (prior.version !== version || pending.some(item => !prior.files.some(file => JSON.stringify(file) === JSON.stringify(item.entry))) || prior.files.some(file => !pending.some(item => JSON.stringify(file) === JSON.stringify(item.entry)))) throw new Error('Plugin is already installed with different content. Remove it before installing another version.');
      for (const entry of prior.files) if (await currentHash(pluginsRoot, entry) !== entry.sha256) throw new Error(`Installed plugin file was changed or removed: ${entry.path}`);
      return {name, version, alreadyInstalled: true, warnings};
    }
    const packageRoot = await safePath(pluginsRoot, name);
    if (await exists(packageRoot)) throw new Error('Plugin directory already exists without a receipt; refusing to overwrite it.');
    const owned = pending;
    const serialized = JSON.stringify({name, version, files: owned.map(item => item.entry)}, null, 2);
    if (Buffer.byteLength(serialized) > PLUGIN_LIMITS.json) throw new Error('Plugin receipt exceeds size limit.');
    const created: {entry: OwnedFile; identity: Stats; completed?: Stats}[] = [];
    const receiptPath = await safePath(receiptsRoot, `${name}.json`);
    const temporaryReceipt = await safePath(receiptsRoot, `.${name}-${randomUUID()}.tmp`);
    try {
      for (const item of pending) {
        const target = await pluginTarget(pluginsRoot, item.entry);
        await fs.mkdir(path.dirname(target), {recursive: true});
        const handle = await fs.open(target, 'wx', item.entry.executable ? 0o755 : 0o644);
        try {
          const record = {entry: item.entry, identity: await handle.stat(), completed: undefined as Stats | undefined};
          created.push(record);
          await handle.writeFile(item.data);
          await handle.chmod(item.entry.executable ? 0o755 : 0o644);
          record.completed = await handle.stat();
        } finally { await handle.close(); }
      }
      await fs.writeFile(temporaryReceipt, serialized, {flag: 'wx', mode: 0o600});
      await fs.rename(temporaryReceipt, receiptPath);
    } catch (error) {
      for (const {entry, identity, completed} of created.reverse()) {
        try {
          // Only a completed, untouched write is ours to undo. In particular,
          // a same-content replacement inode is not transaction-owned.
          if (!completed) continue;
          const target = await pluginTarget(pluginsRoot, entry);
          const actual = await fs.lstat(target);
          if (!actual.isFile() || actual.dev !== identity.dev || actual.ino !== identity.ino ||
              actual.size !== completed.size || actual.mode !== completed.mode ||
              actual.mtimeMs !== completed.mtimeMs || actual.ctimeMs !== completed.ctimeMs ||
              await currentHash(pluginsRoot, entry) !== entry.sha256) continue;
          await fs.unlink(target);
          await prune(pluginsRoot, entry.path);
        } catch { /* Cleanup is best-effort and must not mask the install error. */ }
      }
      try { if (await exists(temporaryReceipt)) await fs.unlink(temporaryReceipt); } catch { /* Preserve the original error. */ }
      throw error;
    }
    return {name, version, alreadyInstalled: false, warnings};
  });
}

export async function enumeratePlugins(): Promise<PluginEnumeration> {
  const receiptsRoot = await receiptsHome();
  const directory = await safePath(receiptsRoot);
  if (!await exists(directory)) return {plugins: [], errors: []};
  const entries: string[] = [];
  for await (const entry of await fs.opendir(directory)) {
    if (entries.length >= PLUGIN_LIMITS.entries) throw new Error('Too many plugin receipts.');
    entries.push(entry.name);
  }
  const plugins: InstalledPlugin[] = [];
  const errors: PluginEnumeration['errors'] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue;
    const name = entry.slice(0, -5);
    try {
      validatePluginName(name);
      const installed = await receipt(receiptsRoot, name);
      if (installed) plugins.push({name, ...(installed.version === undefined ? {} : {version: installed.version})});
    } catch (error) {
      errors.push({directory: `${path.join(receiptsRoot, entry)}`, message: error instanceof Error ? error.message : String(error)});
    }
  }
  return {plugins, errors};
}

export async function listPlugins(): Promise<InstalledPlugin[]> {
  const {plugins, errors} = await enumeratePlugins();
  if (errors.length) throw new Error(errors.map(error => `${error.directory}: ${error.message}`).join('\n'));
  return plugins;
}

export async function removePlugin(name: string): Promise<PluginRemoveResult> {
  validatePluginName(name);
  const pluginsRoot = await pluginsHome();
  const receiptsRoot = await receiptsHome();
  return withLock(receiptsRoot, async () => {
    const installed = await receipt(receiptsRoot, name);
    if (!installed) throw new Error('Plugin is not installed.');
    const retained: string[] = [];
    const removable: OwnedFile[] = [];
    // Preflight all paths before any mutation. Changed files are never removed.
    for (const entry of installed.files) {
      try {
        const actual = await currentHash(pluginsRoot, entry);
        if (actual === undefined) continue;
        if (actual === entry.sha256) removable.push(entry);
        else retained.push(entry.path);
      } catch { retained.push(entry.path); }
    }
    for (const entry of removable) {
      // Recheck immediately before unlinking, to avoid deleting changed content.
      if (await currentHash(pluginsRoot, entry) !== entry.sha256) { retained.push(entry.path); continue; }
      await fs.unlink(await pluginTarget(pluginsRoot, entry));
      await prune(pluginsRoot, entry.path);
    }
    // Report leftover unowned package content as well as changed owned files.
    let visited = 0;
    async function leftovers(relative: string, depth = 0): Promise<void> {
      try {
        const directory = await safePath(pluginsRoot, relative);
        if (!await exists(directory)) return;
        if (depth > 32) { retained.push(`plugins/${relative}`); return; }
        for await (const entry of await fs.opendir(directory)) {
          if (++visited > PLUGIN_LIMITS.entries) { retained.push(`plugins/${relative}`); return; }
          const child = `${relative}/${entry.name}`;
          if (entry.isDirectory()) await leftovers(child, depth + 1);
          else retained.push(`plugins/${child}`);
        }
      } catch { retained.push(`plugins/${relative}`); }
    }
    await leftovers(name);
    await fs.unlink(await safePath(receiptsRoot, `${name}.json`));
    return {name, retained: [...new Set(retained)].sort()};
  });
}
