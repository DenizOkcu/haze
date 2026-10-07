import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {PLUGIN_SCHEMA} from '../../src/skills/plugins/package.js';

const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'haze-plugin-command-home-')));
vi.mock('../../src/config/paths.js', () => ({HAZE_DIR: home, GLOBAL_SKILLS_DIR: path.join(home, 'skills'), GLOBAL_PLUGINS_DIR: path.join(home, 'plugins')}));
const {listInstalledPlugins, pluginCollectionEntries, pluginCommandParts, runPluginCommand} = await import('../../src/cli/commands/pluginCommand.js');

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const entry = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
const loader = require.resolve('tsx');
let root: string;
let workspace: string;
let source: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'haze-plugin-command-')));
  workspace = path.join(root, 'workspace');
  source = path.join(root, 'collection', 'plugins', 'example plugin');
  await fs.ensureDir(workspace);
  await fs.outputJson(path.join(source, 'plugin.json'), {$schema: PLUGIN_SCHEMA, name: 'example', version: '1.0.0', description: 'Test workflow'});
  await fs.outputFile(path.join(source, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Test review\n---\nReview code.\n');
  await fs.outputJson(path.join(root, 'collection', '.claude-plugin', 'marketplace.json'), {name: 'examples', owner: {name: 'Test'}, plugins: [{name: 'example', source: './plugins/example plugin'}]});
});
afterEach(async () => { await fs.remove(root); });

describe('plugin command', () => {
  it('parses quoted paths without shell execution or expansion', () => {
    expect(pluginCommandParts('install "../a path" example')).toEqual(['install', '../a path', 'example']);
    expect(pluginCommandParts("inspect '../a path' example")).toEqual(['inspect', '../a path', 'example']);
    expect(pluginCommandParts('install $(touch)/package')).toEqual(['install', '$(touch)/package']);
    expect(() => pluginCommandParts('install "unfinished')).toThrow('Invalid plugin arguments');
  });

  it('inspects a collection, installs selected content globally, lists and removes', async () => {
    const collection = path.join(root, 'collection');
    expect(await runPluginCommand(['inspect', collection], workspace)).toContain('Plugin collection: examples\nexample');
    expect(await runPluginCommand(['inspect', collection, 'example'], workspace)).toContain('1 standard skills');
    expect(await runPluginCommand(['install', collection, 'example'], workspace)).toContain('Installed example@1.0.0');
    expect(await fs.pathExists(path.join(home, 'plugins', 'example', 'skills', 'review', 'SKILL.md'))).toBe(true);
    await expect(fs.pathExists(path.join(workspace, '.haze'))).resolves.toBe(false);
    expect(await runPluginCommand(['list'], workspace)).toBe('example@1.0.0');
    expect(await runPluginCommand(['install', source], workspace)).toContain('already installed');
    expect(await runPluginCommand(['remove', 'example'], workspace)).toContain('Removed plugin example');
    expect(await runPluginCommand(['list'], workspace)).toContain('No plugins');
  });

  it('reports unsupported features and remote sources honestly', async () => {
    await fs.outputJson(path.join(source, '.mcp.json'), {mcpServers: {}});
    expect(await runPluginCommand(['inspect', source], workspace)).toContain('not activated');
    await expect(runPluginCommand(['install', 'https://example.com/plugins'], workspace)).rejects.toThrow('Clone');
    await expect(runPluginCommand(['install', path.join(root, 'collection')], workspace)).rejects.toThrow('select a plugin name');
  });

  it('gives root plugins precedence over colocated marketplace catalogs', async () => {
    await fs.outputJson(path.join(source, '.claude-plugin', 'marketplace.json'), {name: 'other', plugins: []});
    expect(await runPluginCommand(['inspect', source], workspace)).toContain('example@1.0.0');
  });

  it('exposes picker helpers: installed list and collection entries', async () => {
    await expect(pluginCollectionEntries(source)).rejects.toThrow('Not a plugin collection.');
    const entries = await pluginCollectionEntries(path.join(root, 'collection'));
    expect(entries).toEqual([{name: 'example'}]);
    await expect(pluginCollectionEntries(path.join(root, 'missing'))).rejects.toThrow();
    const withDescription = path.join(root, 'collection2', 'plugins', 'example');
    await fs.ensureDir(withDescription);
    await fs.outputJson(path.join(withDescription, 'plugin.json'), {$schema: PLUGIN_SCHEMA, name: 'example', version: '2.0.0', description: 'Second'});
    await fs.outputJson(path.join(root, 'collection2', '.claude-plugin', 'marketplace.json'), {name: 'c2', plugins: [{name: 'example', description: 'Review workflows', source: './plugins/example'}]});
    expect(await pluginCollectionEntries(path.join(root, 'collection2'))).toEqual([{name: 'example', description: 'Review workflows'}]);
    await runPluginCommand(['install', path.join(root, 'collection'), 'example'], workspace);
    expect(await listInstalledPlugins()).toEqual([{name: 'example', version: '1.0.0'}]);
  });

  it('returns usage for invalid actions/arity without mutation', async () => {
    expect(await runPluginCommand([], workspace)).toContain('plugin install');
    for (const args of [['unknown', source], ['install'], ['list', source], ['remove', 'example', 'extra']]) {
      await expect(runPluginCommand(args, workspace)).rejects.toThrow('plugin inspect');
    }
    expect(await fs.pathExists(path.join(workspace, '.haze', 'plugins'))).toBe(false);
  });

  it('real CLI supports plugin and kit aliases and truthful failure exit codes', async () => {
    const env = {...process.env, HOME: path.join(root, 'home'), NO_COLOR: '1'};
    const cli = (...args: string[]) => exec(process.execPath, ['--import', loader, entry, ...args], {cwd: workspace, env});
    expect((await cli('kit', 'install', source)).stdout).toContain('Installed example');
    expect((await cli('plugin', 'list')).stdout).toContain('example@1.0.0');
    expect((await cli('kit', 'remove', 'example')).stdout).toContain('Removed plugin');
    await expect(cli('plugin', 'install', path.join(root, 'collection'))).rejects.toMatchObject({code: 1});
  }, 15_000);
});
