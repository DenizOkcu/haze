import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {inspectKit, installKit, listKits, removeKit} from '../../src/skills/kits.js';
import {loadSkill} from '../../src/skills/SkillLoader.js';

let temp: string;
let source: string;
let workspace: string;
const skill = '---\nname: demo\ndescription: A synthetic kit skill\n---\n\nRead carefully.\n';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const entry = (source: string, destination: string, text: string) => ({source, destination, sha256: sha(text)});
let manifest: {schemaVersion: number; id: string; version: string; description: string; platforms: string[]; files: Array<ReturnType<typeof entry> & {mode?: string; executable?: boolean}>};
async function save() { await fs.writeFile(path.join(source, 'kit.json'), JSON.stringify(manifest)); }
async function exists(relative: string) { return fs.stat(path.join(workspace, relative)).then(() => true, () => false); }
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-kits-test-'));
  source = path.join(temp, 'source kit');
  workspace = path.join(temp, 'workspace');
  await fs.mkdir(source);
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(source, 'skill.md'), skill);
  await fs.writeFile(path.join(source, 'constitution.md'), 'Seed constitution');
  manifest = {schemaVersion: 1, id: 'demo', version: '1.0.0', description: 'Fixture', platforms: [process.platform], files: [entry('skill.md', '.haze/skills/demo/SKILL.md', skill), {...entry('constitution.md', '.specify/memory/constitution.md', 'Seed constitution'), mode: 'seed'}]};
  await save();
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(temp, {recursive: true, force: true}); });

describe('local skill kits', () => {
  it('inspects without modifying workspace, installs valid skills and records exact provenance', async () => {
    expect(await inspectKit(source)).toContain('Manifest SHA-256:');
    expect(await exists('.haze')).toBe(false);
    expect(await installKit(source, workspace)).toContain('Installed demo@1.0.0');
    expect((await loadSkill(path.join(workspace, '.haze/skills/demo'), 'project'))?.name).toBe('demo');
    const record = JSON.parse(await fs.readFile(path.join(workspace, '.haze/kits/demo.json'), 'utf8'));
    expect(record.source).toBe(await fs.realpath(source));
    expect(record.owned).toEqual(['.haze/skills/demo/SKILL.md']);
    expect(await listKits(workspace)).toContain('demo@1.0.0');
    expect(await installKit(source, workspace)).toContain('already installed');
  });
  it('preserves customized constitution and user reports on removal', async () => {
    await fs.mkdir(path.join(workspace, '.specify/memory'), {recursive: true});
    await fs.writeFile(path.join(workspace, '.specify/memory/constitution.md'), 'User principles');
    await installKit(source, workspace);
    expect(await fs.readFile(path.join(workspace, '.specify/memory/constitution.md'), 'utf8')).toBe('User principles');
    await fs.mkdir(path.join(workspace, 'specs'));
    await fs.writeFile(path.join(workspace, 'specs/user.md'), 'User artifact');
    await removeKit('demo', workspace);
    expect(await exists('.haze/skills/demo/SKILL.md')).toBe(false);
    expect(await exists('.specify/memory/constitution.md')).toBe(true);
    expect(await exists('specs/user.md')).toBe(true);
    expect(await listKits(workspace)).toContain('No kits');
  });
  it('does not take ownership of pre-existing identical files', async () => {
    await fs.mkdir(path.join(workspace, '.haze/skills/demo'), {recursive: true});
    await fs.writeFile(path.join(workspace, '.haze/skills/demo/SKILL.md'), skill);
    await installKit(source, workspace);
    await removeKit('demo', workspace);
    expect(await exists('.haze/skills/demo/SKILL.md')).toBe(true);
  });
  it('retains modified skills and clearly reports that they remain discoverable', async () => {
    await installKit(source, workspace);
    await fs.appendFile(path.join(workspace, '.haze/skills/demo/SKILL.md'), 'User edit');
    await expect(installKit(source, workspace)).rejects.toThrow('changed');
    expect(await removeKit('demo', workspace)).toContain('still-discoverable skills');
    expect(await exists('.haze/skills/demo/SKILL.md')).toBe(true);
  });
  it('preflights conflicts before creating any payload files', async () => {
    await fs.mkdir(path.join(workspace, '.haze/skills/demo'), {recursive: true});
    await fs.writeFile(path.join(workspace, '.haze/skills/demo/SKILL.md'), 'User content');
    await expect(installKit(source, workspace)).rejects.toThrow('Refusing to overwrite');
    expect(await exists('.specify/memory/constitution.md')).toBe(false);
    expect(await exists('.haze/kits/install.lock')).toBe(false);
  });
  it('rejects tampered payloads before writing to the workspace', async () => {
    await fs.writeFile(path.join(source, 'skill.md'), 'Tampered');
    await expect(installKit(source, workspace)).rejects.toThrow('checksum');
    expect(await exists('.haze')).toBe(false);
  });
  it.each(['../escape', '/absolute', '.haze/skills/demo/../../escape', 'src/app.ts', '.specify/scripts/../escape'])('rejects unsafe destination %s', async destination => {
    manifest.files[0]!.destination = destination;
    await save();
    await expect(installKit(source, workspace)).rejects.toThrow();
    expect(await exists('.haze')).toBe(false);
  });
  it('rejects protected source names without reading them', async () => {
    manifest.files[0]!.source = '.env';
    await save();
    await expect(installKit(source, workspace)).rejects.toThrow('Protected secret');
  });
  it('rejects symlink payloads and symlinked destination ancestors', async () => {
    await fs.symlink(path.join(source, 'skill.md'), path.join(source, 'link.md'));
    manifest.files[0]!.source = 'link.md';
    await save();
    await expect(installKit(source, workspace)).rejects.toThrow('Symlinks');
    manifest.files[0]!.source = 'skill.md';
    await save();
    await fs.symlink(source, path.join(workspace, '.haze'));
    await expect(installKit(source, workspace)).rejects.toThrow('Symlinks');
  });
  it('rejects duplicate paths, unsupported platforms and changed installed versions', async () => {
    manifest.files.push(manifest.files[0]!);
    await save();
    await expect(installKit(source, workspace)).rejects.toThrow('Duplicate');
    manifest.files.pop();
    manifest.platforms = [process.platform === 'win32' ? 'linux' : 'win32'];
    await save();
    await expect(installKit(source, workspace)).rejects.toThrow('does not support');
    manifest.platforms = [process.platform];
    await save();
    await installKit(source, workspace);
    manifest.version = '2.0.0';
    await save();
    await expect(installKit(source, workspace)).rejects.toThrow('different manifest');
  });
  it('rolls back newly created files if receipt persistence fails', async () => {
    const original = fs.writeFile;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]).endsWith('/kits/demo.json')) throw new Error('Simulated disk failure');
      return original(...args);
    });
    await expect(installKit(source, workspace)).rejects.toThrow('Simulated disk failure');
    expect(await exists('.haze/skills/demo/SKILL.md')).toBe(false);
    expect(await exists('.specify/memory/constitution.md')).toBe(false);
    expect(await exists('.haze/kits/install.lock')).toBe(false);
  });
  it('rejects concurrent operations and cross-kit file ownership', async () => {
    await fs.mkdir(path.join(workspace, '.haze/kits/install.lock'), {recursive: true});
    await expect(installKit(source, workspace)).rejects.toThrow('Another kit operation');
    await fs.rmdir(path.join(workspace, '.haze/kits/install.lock'));
    await installKit(source, workspace);
    manifest.id = 'another';
    await save();
    await expect(installKit(source, workspace)).rejects.toThrow('Another kit already manages');
  });
});
