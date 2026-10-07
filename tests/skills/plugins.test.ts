import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inspectPlugin, readPluginManifest, PLUGIN_SCHEMA, PLUGIN_LIMITS} from '../../src/skills/plugins/package.js';

const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'haze-plugins-')));
const home = path.join(tmp, 'home');
vi.mock('../../src/config/paths.js', () => ({HAZE_DIR: home, GLOBAL_SKILLS_DIR: path.join(home, 'skills'), GLOBAL_PLUGINS_DIR: path.join(home, 'plugins')}));
const {enumeratePlugins, installPlugin, listPlugins, removePlugin} = await import('../../src/skills/plugins/installer.js');

let source: string;
let cwd: string;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
async function write(root: string, file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, file)), {recursive: true});
  await fs.writeFile(path.join(root, file), content);
}
async function manifest(value: Record<string, unknown> = {name: 'demo', version: '1.0.0'}, file = 'plugin.json'): Promise<void> {
  await write(source, file, JSON.stringify(file === 'plugin.json' ? {$schema: PLUGIN_SCHEMA, ...value} : value));
}
beforeEach(async () => {
  for (const entry of await fs.readdir(tmp)) await fs.rm(path.join(tmp, entry), {recursive: true, force: true});
  source = path.join(tmp, 'source');
  cwd = path.join(tmp, 'workspace');
  await fs.mkdir(source);
  await fs.mkdir(cwd);
});
afterEach(async () => { vi.restoreAllMocks(); });

describe('plugin package inspection', () => {
  it('prefers canonical manifest and warns about unsupported components', async () => {
    await manifest({name: 'demo', hooks: {}, custom: true, skills: ['./custom-skills']});
    await manifest({name: 'other'}, '.claude-plugin/plugin.json');
    const result = await inspectPlugin(source);
    expect(result.root).toBe(source);
    expect(result.manifest).toEqual({$schema: PLUGIN_SCHEMA, name: 'demo'});
    expect(result.files).toEqual(['.claude-plugin/plugin.json', 'plugin.json']);
    expect(result.warnings.join(' ')).toMatch(/hooks.*custom.*skills/);
  });
  it.each(['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'])('supports %s fallback', async file => {
    await manifest({name: 'demo'}, file);
    expect((await inspectPlugin(source)).manifest.name).toBe('demo');
  });
  it.each([
    ['.claude-plugin/marketplace.json', './demo'],
    ['.agents/plugins/marketplace.json', {source: 'local', path: './demo'}],
  ])('selects a local collection entry in %s', async (file, entry) => {
    await write(source, String(file), JSON.stringify({plugins: [{name: 'demo', source: entry}]}));
    await write(source, 'demo/plugin.json', JSON.stringify({$schema: PLUGIN_SCHEMA, name: 'demo'}));
    await expect(inspectPlugin(source)).rejects.toThrow(/select/);
    expect((await inspectPlugin(source, 'demo')).root).toBe(path.join(source, 'demo'));
  });
  it('infers manifest-less Claude standard-layout names from basename or explicit selection', async () => {
    await write(source, 'skills/review/SKILL.md', '# Review');
    expect(await readPluginManifest(source)).toEqual({manifest: {name: 'source'}, format: 'claude', warnings: [expect.stringMatching(/inferred.*source/)]});
    const result = await inspectPlugin(source, 'chosen');
    expect(result.manifest).toEqual({name: 'chosen'});
    expect(result.files).toEqual(['skills/review/SKILL.md']);
    expect(result.warnings.join(' ')).toMatch(/inferred.*chosen/);
    await expect(readPluginManifest(source, '../unsafe')).rejects.toThrow(/name/);
  });
  it.each(['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'])('infers the selected collection name rather than source dirname in %s', async file => {
    await write(source, file, JSON.stringify({plugins: [{name: 'chosen', source: './different-directory'}]}));
    await write(source, 'different-directory/skills/review/SKILL.md', '# Review');
    const result = await inspectPlugin(source, 'chosen');
    expect(result.root).toBe(path.join(source, 'different-directory'));
    expect(result.manifest.name).toBe('chosen');
  });
  it('rejects manifest-less empty directories, non-directory skills and symlinked skills', async () => {
    await expect(readPluginManifest(source)).rejects.toThrow(/No .*manifest/);
    await expect(inspectPlugin(source)).rejects.toThrow(/No .*manifest/);
    await write(source, 'skills', 'not a directory');
    await expect(inspectPlugin(source)).rejects.toThrow(/No .*manifest/);
    await fs.unlink(path.join(source, 'skills'));
    await fs.symlink(cwd, path.join(source, 'skills'));
    await expect(readPluginManifest(source)).rejects.toThrow(/Symlinks/);
    await expect(inspectPlugin(source)).rejects.toThrow(/Symlinks/);
  });
  it.each(['plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'])('keeps %s authoritative over standard-layout inference', async file => {
    await write(source, 'skills/review/SKILL.md', '# Review');
    await manifest({name: 'declared'}, file);
    expect((await readPluginManifest(source, 'chosen')).manifest.name).toBe('declared');
    await expect(inspectPlugin(source, 'chosen')).rejects.toThrow(/does not match/);
    await write(source, file, '{');
    await expect(readPluginManifest(source, 'chosen')).rejects.toThrow();
    await expect(inspectPlugin(source, 'chosen')).rejects.toThrow();
  });
  it('supports OpenAI local entry source/path shape', async () => {
    await write(source, '.agents/plugins/marketplace.json', JSON.stringify({plugins: [{name: 'demo', source: 'local', path: './demo'}]}));
    await write(source, 'demo/plugin.json', JSON.stringify({$schema: PLUGIN_SCHEMA, name: 'demo'}));
    expect((await inspectPlugin(source, 'demo')).manifest.name).toBe('demo');
  });
  it('rejects remote sources, collection traversal and unsafe names', async () => {
    await expect(inspectPlugin('https://example.com/demo')).rejects.toThrow(/Clone/);
    await write(source, '.claude-plugin/marketplace.json', JSON.stringify({plugins: [{name: 'demo', source: './../escape'}]}));
    await expect(inspectPlugin(source, 'demo')).rejects.toThrow(/escape/);
    await manifest({name: '../unsafe'});
    await expect(inspectPlugin(source)).rejects.toThrow(/name/);
  });
  it('rejects secrets without reading them', async () => {
    await manifest();
    // A zero-byte sentinel exercises refusal; no secret contents are created or read.
    await write(source, '.env', '');
    const spy = vi.spyOn(fs, 'open');
    await expect(inspectPlugin(source)).rejects.toThrow(/secret/);
    expect(spy.mock.calls.every(([file]) => !String(file).endsWith('.env'))).toBe(true);
  });
  it('rejects package symlinks but canonicalizes source root aliases', async () => {
    await manifest();
    await fs.symlink(path.join(source, 'plugin.json'), path.join(source, 'alias.json'));
    await expect(inspectPlugin(source)).rejects.toThrow(/Symlinks/);
    await fs.symlink(source, path.join(tmp, 'alias'));
    await fs.unlink(path.join(source, 'alias.json'));
    expect((await inspectPlugin(path.join(tmp, 'alias'))).root).toBe(source);
  });
  it('bounds manifest and package file sizes', async () => {
    await write(source, 'plugin.json', ' '.repeat(PLUGIN_LIMITS.json + 1));
    await expect(inspectPlugin(source)).rejects.toThrow(/size limit/);
    await manifest();
    await write(source, 'large.txt', 'x'.repeat(PLUGIN_LIMITS.file + 1));
    await expect(inspectPlugin(source)).rejects.toThrow(/size limits/);
  });
});

describe('portable v1 manifest validation', () => {
  it.each([undefined, null, 1, 'https://agent-plugins.org/schemas/1.1.0/plugin.schema.json'])('rejects unsupported or missing schema %s without legacy fallback', async $schema => {
    await manifest({name: 'demo', $schema});
    await manifest({name: 'legacy'}, '.claude-plugin/plugin.json');
    await expect(readPluginManifest(source)).rejects.toThrow(/\$schema/);
  });
  it.each(['Demo', 'under_score', '-demo', 'demo-', '.demo', 'demo.', 'a--b', 'a..b', 'demo\n', '', 'a'.repeat(65), '../escape'])('rejects canonical name %s', async name => {
    await manifest({name});
    await expect(readPluginManifest(source)).rejects.toThrow(/name/);
  });
  it.each(['a', 'demo.plugin', 'a-b.c', 'a'.repeat(64)])('accepts canonical name %s', async name => {
    await manifest({name});
    expect(await readPluginManifest(source)).toMatchObject({manifest: {name}, format: 'portable', warnings: []});
  });
  it.each(['version', 'description', 'homepage', 'repository', 'license'])('requires string %s', async field => {
    for (const value of [null, 1, {}, [], true]) {
      await manifest({name: 'demo', [field]: value});
      await expect(readPluginManifest(source)).rejects.toThrow(field);
    }
  });
  it.each([null, 'author', [], {name: 1}, {email: null}, {url: []}, {extra: 'x'}])('rejects invalid author %j', async author => {
    await manifest({name: 'demo', author});
    await expect(readPluginManifest(source)).rejects.toThrow(/object|author/);
  });
  it.each([null, 'keyword', {}, [1], ['valid', false]])('rejects invalid keywords %j', async keywords => {
    await manifest({name: 'demo', keywords});
    await expect(readPluginManifest(source)).rejects.toThrow(/keywords/);
  });
  it('accepts all core metadata without imposing URL, email or semver formats', async () => {
    const metadata = {name: 'demo', version: '', description: '', homepage: 'local', repository: 'repo', license: 'custom', author: {name: '', email: 'plain', url: 'local'}, keywords: ['', 'keyword']};
    await manifest(metadata);
    expect((await readPluginManifest(source)).manifest).toEqual({$schema: PLUGIN_SCHEMA, ...metadata});
    await manifest({name: 'demo', author: {}});
    await expect(readPluginManifest(source)).resolves.toMatchObject({manifest: {author: {}}});
  });
  it.each([null, [], false, 'extensions', 42])('warns and ignores non-object extensions %j', async extensions => {
    await manifest({name: 'demo', extensions});
    const result = await readPluginManifest(source);
    expect(result.manifest).not.toHaveProperty('extensions');
    expect(result.warnings.join(' ')).toMatch(/extensions.*ignored/);
  });
  it('ignores all extension namespaces including dev.haze without activating them', async () => {
    await manifest({name: 'demo', extensions: {'example.null': null, 'example.object': {anything: true}, 'dev.haze': {workspaceFiles: [{source: 'dev.haze/x', destination: '.specify/x', sha256: '0'.repeat(64), mode: 'managed'}]}}});
    const result = await readPluginManifest(source);
    expect(result.manifest.extensions).toEqual({});
    expect(result.warnings).toHaveLength(3);
  });
  it.each(['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'])('preserves legacy names and custom skills in %s', async file => {
    await manifest({name: 'My_Plugin.v2', skills: ['./custom'], author: 'legacy'}, file);
    const result = await readPluginManifest(source);
    expect(result.format).toBe(file.includes('claude') ? 'claude' : 'codex');
    expect(result.manifest).toMatchObject({name: 'My_Plugin.v2', skills: ['./custom'], author: 'legacy'});
  });
  it('reads only the manifest, while inspection diagnoses unsupported files without opening them', async () => {
    await manifest();
    const components = ['mcp.json', '.mcp.json', '.lsp.json', 'hooks/config.json', 'agents/agent.md', 'commands/run.md', 'rules/rule.md'];
    for (const file of components) await write(source, file, 'invalid configuration');
    const open = vi.spyOn(fs, 'open');
    const walk = vi.spyOn(fs, 'opendir');
    await readPluginManifest(source);
    expect(walk).not.toHaveBeenCalled();
    const result = await inspectPlugin(source);
    for (const file of components) expect(result.warnings.join(' ')).toContain(file.split('/')[0]);
    expect(open.mock.calls.every(([file]) => String(file) === path.join(source, 'plugin.json'))).toBe(true);
  });
  it('does not walk unrelated symlinks during runtime manifest loading', async () => {
    await manifest();
    await fs.symlink(cwd, path.join(source, 'unrelated'));
    await expect(readPluginManifest(source)).resolves.toMatchObject({format: 'portable'});
    await expect(inspectPlugin(source)).rejects.toThrow(/Symlinks/);
  });
  it('refuses symlinked manifests even at runtime', async () => {
    await write(cwd, 'manifest.json', JSON.stringify({name: 'demo', $schema: PLUGIN_SCHEMA}));
    await fs.symlink(path.join(cwd, 'manifest.json'), path.join(source, 'plugin.json'));
    await expect(readPluginManifest(source)).rejects.toThrow(/Symlinks/);
  });
  it.each(['[]', 'null', '{', '{}', '{"$schema":"bad","name":1}'])('rejects malformed manifest %s', async content => {
    await write(source, 'plugin.json', content);
    await expect(readPluginManifest(source)).rejects.toThrow();
  });
  it('bounds collection recursion and refuses cyclic symlink sources', async () => {
    let root = source;
    for (let i = 0; i < 34; i++) {
      await write(root, '.claude-plugin/marketplace.json', JSON.stringify({plugins: [{name: 'demo', source: './next'}]}));
      root = path.join(root, 'next');
    }
    await fs.mkdir(root, {recursive: true});
    await expect(inspectPlugin(source, 'demo')).rejects.toThrow(/collection nesting/);
    await fs.symlink(source, path.join(source, 'loop'));
    await write(source, '.claude-plugin/marketplace.json', JSON.stringify({plugins: [{name: 'demo', source: './loop'}]}));
    await expect(inspectPlugin(source, 'demo')).rejects.toThrow(/Symlinks/);
  });
});

describe('global plugin installer ownership', () => {
  it('copies the complete package into ~/.haze, records hashes and installs idempotently', async () => {
    await manifest();
    await write(source, 'skills/demo/SKILL.md', '# Instructions');
    expect(await listPlugins()).toEqual([]);
    expect(await installPlugin(source)).toMatchObject({name: 'demo', version: '1.0.0', alreadyInstalled: false});
    expect(await fs.readFile(path.join(home, 'plugins/demo/skills/demo/SKILL.md'), 'utf8')).toBe('# Instructions');
    expect(await listPlugins()).toEqual([{name: 'demo', version: '1.0.0'}]);
    expect(await installPlugin(source)).toMatchObject({alreadyInstalled: true});
    const receipt = JSON.parse(await fs.readFile(path.join(home, 'plugin-receipts/demo.json'), 'utf8'));
    expect(receipt.files).toContainEqual(expect.objectContaining({path: 'plugins/demo/skills/demo/SKILL.md', sha256: digest('# Instructions')}));
    expect(await removePlugin('demo')).toEqual({name: 'demo', retained: []});
    expect(await listPlugins()).toEqual([]);
    await expect(fs.stat(path.join(cwd, '.haze'))).rejects.toMatchObject({code: 'ENOENT'});
  });
  it('never writes into the workspace during install or remove', async () => {
    await manifest();
    await write(source, 'skills/demo/SKILL.md', '# Instructions');
    await write(source, 'dev.haze/template.md', 'template');
    await installPlugin(source);
    await expect(fs.stat(path.join(cwd, '.specify'))).rejects.toMatchObject({code: 'ENOENT'});
    await removePlugin('demo');
    await expect(fs.stat(path.join(cwd, '.haze'))).rejects.toMatchObject({code: 'ENOENT'});
  });
  it('isolates corrupt and invalidly named receipts while listing remains strict', async () => {
    await manifest();
    await installPlugin(source);
    await write(home, 'plugin-receipts/broken.json', '{');
    await write(home, 'plugin-receipts/invalid name.json', '{}');
    const result = await enumeratePlugins();
    expect(result.plugins).toEqual([{name: 'demo', version: '1.0.0'}]);
    expect(result.errors.map(error => error.directory)).toEqual([path.join(home, 'plugin-receipts', 'broken.json'), path.join(home, 'plugin-receipts', 'invalid name.json')]);
    await expect(listPlugins()).rejects.toThrow(/broken\.json/);
  });
  it('normalizes bundled script modes without executing them and remains idempotent', async () => {
    await manifest();
    await write(source, 'scripts/direct.sh', `#!/bin/sh\ntouch '${path.join(cwd, 'executed')}'\n`);
    await fs.chmod(path.join(source, 'scripts/direct.sh'), 0o751);
    await write(source, 'notes.md', 'notes');
    await fs.chmod(path.join(source, 'notes.md'), 0o600);
    await installPlugin(source);
    expect((await fs.stat(path.join(home, 'plugins/demo/scripts/direct.sh'))).mode & 0o777).toBe(0o755);
    expect((await fs.stat(path.join(home, 'plugins/demo/notes.md'))).mode & 0o777).toBe(0o644);
    await expect(fs.stat(path.join(cwd, 'executed'))).rejects.toMatchObject({code: 'ENOENT'});
    expect((await installPlugin(source)).alreadyInstalled).toBe(true);
  });
  it('preserves changed files and rejects changed reinstallation', async () => {
    await manifest();
    await write(source, 'notes.md', 'original');
    await installPlugin(source);
    await write(home, 'plugins/demo/notes.md', 'changed');
    await expect(installPlugin(source)).rejects.toThrow(/changed/);
    expect(await removePlugin('demo')).toEqual({name: 'demo', retained: ['plugins/demo/notes.md']});
    expect(await fs.readFile(path.join(home, 'plugins/demo/notes.md'), 'utf8')).toBe('changed');
  });
  it('refuses lock contention and symlinked plugin directories', async () => {
    await manifest();
    await write(home, 'plugin-receipts/.lock', '');
    await expect(installPlugin(source)).rejects.toThrow(/locked/);
    await fs.unlink(path.join(home, 'plugin-receipts/.lock'));
    await fs.symlink(source, path.join(home, 'plugins'));
    await expect(installPlugin(source)).rejects.toThrow(/Symlinks/);
  });
  it('rolls back created files if writing the receipt fails', async () => {
    await manifest();
    const original = fs.writeFile;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (file, ...args) => {
      if (String(file).includes('plugin-receipts/.demo-')) throw new Error('simulated receipt failure');
      return original(file, ...args);
    });
    await expect(installPlugin(source)).rejects.toThrow(/simulated/);
    await expect(fs.stat(path.join(home, 'plugins/demo'))).rejects.toMatchObject({code: 'ENOENT'});
    expect(await listPlugins()).toEqual([]);
    await expect(fs.stat(path.join(home, 'plugin-receipts/.lock'))).rejects.toMatchObject({code: 'ENOENT'});
  });
  it('continues rollback after per-file cleanup errors without masking the install failure', async () => {
    await manifest();
    await write(source, 'notes.md', 'notes');
    const unlink = fs.unlink;
    vi.spyOn(fs, 'unlink').mockImplementation(async file => {
      if (String(file).endsWith('/notes.md')) throw new Error('cleanup denied');
      return unlink(file);
    });
    const original = fs.writeFile;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (file, ...args) => {
      if (String(file).includes('plugin-receipts/.demo-')) throw new Error('original receipt failure');
      return original(file, ...args);
    });
    await expect(installPlugin(source)).rejects.toThrow('original receipt failure');
    expect(await fs.readFile(path.join(home, 'plugins/demo/notes.md'), 'utf8')).toBe('notes');
    await expect(fs.stat(path.join(home, 'plugins/demo/plugin.json'))).rejects.toMatchObject({code: 'ENOENT'});
  });
  it('preserves unowned package files during removal', async () => {
    await manifest();
    await installPlugin(source);
    await write(home, 'plugins/demo/user-notes.md', 'user');
    expect(await removePlugin('demo')).toEqual({name: 'demo', retained: ['plugins/demo/user-notes.md']});
    expect(await fs.readFile(path.join(home, 'plugins/demo/user-notes.md'), 'utf8')).toBe('user');
  });
  it('rejects forged receipt paths before removal', async () => {
    await write(home, 'plugin-receipts/demo.json', JSON.stringify({name: 'demo', files: [{path: 'README.md', sha256: '0'.repeat(64), mode: 'package', executable: false}]}));
    await write(home, 'README.md', 'user');
    await expect(removePlugin('demo')).rejects.toThrow();
    expect(await fs.readFile(path.join(home, 'README.md'), 'utf8')).toBe('user');
  });
});
