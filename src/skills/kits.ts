import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {isProtectedSecretPath} from '../core/safety/secretPaths.js';

const safeRelative = z.string().min(1).max(500).refine(value => !value.includes('\\') && !value.includes('\0') && !path.posix.isAbsolute(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Expected a safe relative path');
const destination = safeRelative.refine(value => /^\.haze\/skills\/[A-Za-z0-9_-]+\/.+/.test(value) || /^\.specify\/(scripts|templates|extensions)\/.+/.test(value) || value === '.specify/memory/constitution.md', 'Kit destinations must be skill directories or declared .specify assets');
const kitFile = z.object({source: safeRelative, destination, sha256: z.string().regex(/^[a-f0-9]{64}$/), executable: z.boolean().default(false), mode: z.enum(['managed', 'seed']).default('managed')});
const kitSchema = z.object({schemaVersion: z.literal(1), id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), version: z.string().min(1).max(100), description: z.string().min(1).max(1000), platforms: z.array(z.enum(['darwin', 'linux', 'win32'])).min(1), files: z.array(kitFile).min(1).max(500)});
const receiptSchema = kitSchema.extend({source: z.string(), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/), owned: z.array(destination).max(500)});
type Kit = z.infer<typeof kitSchema>;
type Receipt = z.infer<typeof receiptSchema>;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const FILE_LIMIT = 512 * 1024;

/** Reject all symlink components, including existing destination ancestors. */
async function checkedPath(root: string, relative: string): Promise<string> {
  safeRelative.parse(relative);
  let current = root;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    if (isProtectedSecretPath(current)) throw new Error(`Protected secret path: ${relative}`);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed in kit paths: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return current;
}

async function boundedRead(file: string): Promise<Buffer> {
  if (isProtectedSecretPath(file)) throw new Error('Protected secret path');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > FILE_LIMIT) throw new Error(`Kit file must be a regular file <= ${FILE_LIMIT} bytes: ${file}`);
    const buffer = Buffer.alloc(FILE_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const {bytesRead} = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > FILE_LIMIT) throw new Error('Kit file grew beyond the size limit');
    return Buffer.from(buffer.subarray(0, length));
  } finally { await handle.close(); }
}

async function readKit(source: string): Promise<{kit: Kit; payloads: Buffer[]; manifestSha256: string; root: string}> {
  const lexicalRoot = path.resolve(source);
  if (isProtectedSecretPath(lexicalRoot)) throw new Error('Protected secret path');
  const root = await fs.realpath(lexicalRoot);
  if (isProtectedSecretPath(root)) throw new Error('Protected secret path');
  const manifest = await boundedRead(await checkedPath(root, 'kit.json'));
  const kit = kitSchema.parse(JSON.parse(manifest.toString('utf8')));
  const destinations = new Set<string>();
  const payloads: Buffer[] = [];
  let total = 0;
  for (const file of kit.files) {
    if (destinations.has(file.destination)) throw new Error(`Duplicate kit destination: ${file.destination}`);
    destinations.add(file.destination);
    const bytes = await boundedRead(await checkedPath(root, file.source));
    total += bytes.length;
    if (total > 8 * 1024 * 1024) throw new Error('Kit payload exceeds 8 MiB');
    if (hash(bytes) !== file.sha256) throw new Error(`Kit checksum mismatch: ${file.source}`);
    payloads.push(bytes);
  }
  return {kit, payloads, manifestSha256: hash(manifest), root};
}

async function receipts(cwd: string): Promise<Receipt[]> {
  const directory = await checkedPath(cwd, '.haze/kits');
  let names: string[];
  try { names = await fs.readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result: Receipt[] = [];
  for (const name of names.sort().filter(name => name.endsWith('.json'))) {
    const receipt = receiptSchema.parse(JSON.parse((await boundedRead(await checkedPath(cwd, `.haze/kits/${name}`))).toString()));
    if (name !== `${receipt.id}.json` || receipt.owned.some(owned => !receipt.files.some(file => file.destination === owned))) throw new Error(`Invalid kit receipt: ${name}`);
    result.push(receipt);
  }
  return result;
}

async function locked<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  const directory = await checkedPath(cwd, '.haze/kits');
  await fs.mkdir(directory, {recursive: true});
  const lock = await checkedPath(cwd, '.haze/kits/install.lock');
  try { await fs.mkdir(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another kit operation is active. If an operation crashed, remove .haze/kits/install.lock after confirming no installer is running.', {cause: error});
    throw error;
  }
  try { return await operation(); } finally { await fs.rmdir(lock); }
}

export async function inspectKit(source: string): Promise<string> {
  const {kit, root, manifestSha256} = await readKit(source);
  return `${kit.id}@${kit.version}: ${kit.description}\nSource: ${root}\nManifest SHA-256: ${manifestSha256}\nPlatforms: ${kit.platforms.join(', ')}\nFiles (${kit.files.length}):\n${kit.files.map(file => `  ${file.destination}${file.mode === 'seed' ? ' (create only)' : ''}`).join('\n')}\nInstalling explicitly trusts this local source. Checksums verify integrity, not publisher identity. No setup scripts run.`;
}

export async function installKit(source: string, workspace = process.cwd()): Promise<string> {
  const {kit, payloads, manifestSha256, root} = await readKit(source);
  if (!kit.platforms.includes(process.platform as 'darwin' | 'linux' | 'win32')) throw new Error(`Kit ${kit.id} does not support ${process.platform}`);
  const cwd = await fs.realpath(workspace);
  return locked(cwd, async () => {
    const installed = await receipts(cwd);
    const previous = installed.find(receipt => receipt.id === kit.id);
    if (previous) {
      if (previous.manifestSha256 !== manifestSha256) throw new Error(`Kit ${kit.id} is already installed with a different manifest. Remove it before installing another version; modified files will be preserved.`);
      for (const file of previous.files) {
        if (file.mode === 'seed') continue;
        const target = await checkedPath(cwd, file.destination);
        if (hash(await boundedRead(target)) !== file.sha256) throw new Error(`Installed kit file changed: ${file.destination}`);
      }
      return `${kit.id}@${kit.version} is already installed.`;
    }
    const toCreate: number[] = [];
    for (const [index, file] of kit.files.entries()) {
      if (installed.some(receipt => receipt.files.some(other => other.destination === file.destination))) throw new Error(`Another kit already manages ${file.destination}`);
      const target = await checkedPath(cwd, file.destination);
      try {
        const bytes = await boundedRead(target);
        if (file.mode !== 'seed' && hash(bytes) !== file.sha256) throw new Error(`Refusing to overwrite existing file: ${file.destination}. Use a fresh project or reconcile the file manually.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        toCreate.push(index);
      }
    }
    const created: string[] = [];
    try {
      for (const index of toCreate) {
        const file = kit.files[index]!;
        const target = await checkedPath(cwd, file.destination);
        await fs.mkdir(path.dirname(target), {recursive: true});
        await fs.writeFile(target, payloads[index]!, {flag: 'wx', mode: file.executable ? 0o755 : 0o644});
        created.push(file.destination);
      }
      const receipt: Receipt = {...kit, source: root, manifestSha256, owned: created.filter(name => kit.files.find(file => file.destination === name)?.mode !== 'seed')};
      await fs.writeFile(await checkedPath(cwd, `.haze/kits/${kit.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`, {flag: 'wx'});
    } catch (error) {
      for (const name of created.reverse()) {
        const target = await checkedPath(cwd, name);
        const file = kit.files.find(file => file.destination === name)!;
        if (hash(await boundedRead(target)) === file.sha256) await fs.unlink(target);
      }
      throw error;
    }
    return `Installed ${kit.id}@${kit.version}: ${created.length} new files. Skills are project-local, repository-provided content. No setup scripts ran. Use /skills to inspect or disable them.`;
  });
}

export async function listKits(workspace = process.cwd()): Promise<string> {
  const installed = await receipts(await fs.realpath(workspace));
  return installed.length ? installed.map(kit => `${kit.id}@${kit.version} — ${kit.description}`).join('\n') : 'No kits installed in this project. Use /kit inspect <local-kit-directory>, then /kit install <local-kit-directory>.';
}

export async function removeKit(id: string, workspace = process.cwd()): Promise<string> {
  kitSchema.shape.id.parse(id);
  const cwd = await fs.realpath(workspace);
  return locked(cwd, async () => {
    const receipt = (await receipts(cwd)).find(kit => kit.id === id);
    if (!receipt) throw new Error(`Kit ${id} is not installed in this project`);
    const preserved: string[] = [];
    // Validate every path before removal starts.
    const paths = await Promise.all(receipt.owned.map(name => checkedPath(cwd, name)));
    for (const [index, name] of receipt.owned.entries()) {
      const target = paths[index]!;
      const file = receipt.files.find(file => file.destination === name)!;
      try {
        if (hash(await boundedRead(target)) === file.sha256) await fs.unlink(target);
        else preserved.push(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await fs.unlink(await checkedPath(cwd, `.haze/kits/${id}.json`));
    return `Removed kit ${id}. User artifacts, seed files, pre-existing files and modified files were preserved.${preserved.length ? `\nModified files retained (including any still-discoverable skills):\n${preserved.join('\n')}` : ''}`;
  });
}
