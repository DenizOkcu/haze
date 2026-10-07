import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'haze-plugin-runtime-')));
const global = path.join(tmp, 'global-home');
const cwd = path.join(tmp, 'workspace');
vi.mock('../../src/config/paths.js', () => ({GLOBAL_SKILLS_DIR: path.join(global, 'skills'), HAZE_DIR: global, GLOBAL_PLUGINS_DIR: path.join(global, 'plugins')}));
const {loadSkillRegistry, resolveSkillCandidates} = await import('../../src/skills/SkillRegistry.js');
const {installPlugin, removePlugin} = await import('../../src/skills/plugins/installer.js');
const {PLUGIN_SCHEMA} = await import('../../src/skills/plugins/package.js');
const {isSkillEnabled, setSkillEnabled} = await import('../../src/config/skillSettings.js');

async function write(root: string, file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, file)), {recursive: true});
  await fs.writeFile(path.join(root, file), content);
}
const markdown = (name = 'review', body = 'Review carefully.'): string => `---\nname: ${name}\ndescription: Review code\n---\n${body}\n`;
async function source(name: string, skills?: unknown, legacy = false): Promise<string> {
  const root = path.join(tmp, `source-${name}`);
  await write(root, legacy ? '.claude-plugin/plugin.json' : 'plugin.json', JSON.stringify({name, ...(legacy ? {} : {$schema: PLUGIN_SCHEMA}), ...(skills === undefined ? {} : {skills})}));
  await write(root, 'skills/review/SKILL.md', markdown());
  return root;
}
const installedRoot = (name: string): string => path.join(global, 'plugins', name);
beforeEach(async () => {
  for (const entry of await fs.readdir(tmp)) await fs.rm(path.join(tmp, entry), {recursive: true, force: true});
  await fs.mkdir(cwd);
});
afterAll(async () => { await fs.rm(tmp, {recursive: true, force: true}); });

describe('receipt-installed global plugin skill runtime', () => {
  it('loads actual installations with global provenance, namespace and references', async () => {
    const root = await source('demo');
    await write(root, 'skills/review/SKILL.md', markdown('review', '[Guide](guide.md)'));
    await write(root, 'skills/review/guide.md', 'Guide content');
    await installPlugin(root);
    const registry = await loadSkillRegistry(cwd);
    expect([...registry.skills.keys()]).toEqual(['demo:review']);
    expect(registry.skills.get('demo:review')).toMatchObject({name: 'demo:review', pluginName: 'demo', pluginRoot: installedRoot('demo'), source: 'global', references: [{path: 'guide.md', content: 'Guide content'}]});
    expect(registry.errors).toEqual([]);
  });

  it('activates a manifest-less collection package under its selected installed name', async () => {
    const collection = path.join(tmp, 'collection');
    await write(collection, '.claude-plugin/marketplace.json', JSON.stringify({plugins: [{name: 'chosen', source: './different-directory'}]}));
    await write(collection, 'different-directory/skills/review/SKILL.md', markdown());
    await installPlugin(collection, 'chosen');
    const registry = await loadSkillRegistry(cwd);
    expect([...registry.skills.keys()]).toEqual(['chosen:review']);
    expect(registry.skills.get('chosen:review')).toMatchObject({pluginName: 'chosen', pluginRoot: installedRoot('chosen'), source: 'global'});
    expect(registry.errors).toEqual([]);
  });

  it('reports a corrupt receipt without disabling valid installed plugins', async () => {
    await installPlugin(await source('demo'));
    await installPlugin(await source('bad'));
    await write(global, 'plugin-receipts/bad.json', '{');
    const registry = await loadSkillRegistry(cwd);
    expect([...registry.skills.keys()]).toEqual(['demo:review']);
    expect(registry.errors).toEqual([expect.objectContaining({directory: path.join(global, 'plugin-receipts', 'bad.json'), source: 'global', message: expect.any(String)})]);
  });

  it('lets project skills shadow globally installed plugin skills', async () => {
    await installPlugin(await source('demo'));
    await write(cwd, '.haze/skills/review/SKILL.md', markdown());
    const registry = await loadSkillRegistry(cwd);
    expect(registry.skills.get('demo:review')?.source).toBe('global');
    expect(registry.candidates?.filter(skill => skill.name === 'review').map(skill => skill.source)).toEqual(['project']);
  });

  it('keeps two plugins with the same skill independent of standalone precedence', async () => {
    for (const name of ['one', 'two']) await installPlugin(await source(name));
    await write(path.join(global, 'skills'), 'review/SKILL.md', markdown());
    await write(cwd, '.haze/skills/review/SKILL.md', markdown());
    const registry = await loadSkillRegistry(cwd);
    expect([...registry.skills.keys()].sort()).toEqual(['one:review', 'review', 'two:review']);
    expect(registry.candidates?.filter(skill => skill.name === 'review').map(skill => skill.source)).toEqual(['project', 'global']);
    const settings = {skills: setSkillEnabled({}, 'one:review', false, 'global')};
    const active = resolveSkillCandidates(registry.candidates ?? [], skill => isSkillEnabled(settings, skill.name, skill.source));
    expect(active.has('one:review')).toBe(false);
    expect(active.has('two:review')).toBe(true);
    expect(isSkillEnabled(settings, 'one:review', 'project')).toBe(true);
  });

  it.each(['./custom', ['./custom', './individual']])('adds legacy paths %j without recursive discovery', async custom => {
    const root = await source('demo', custom, true);
    await write(root, 'custom/deep/nested/SKILL.md', markdown('nested'));
    await write(root, 'custom/individual/SKILL.md', markdown('individual'));
    await installPlugin(root);
    const registry = await loadSkillRegistry(cwd);
    // One level deep only: custom/individual loads, custom/deep/nested never does.
    expect([...registry.skills.keys()].sort()).toEqual(['demo:individual', 'demo:review']);
    expect(registry.errors).toEqual([]);
  });

  it('isolates symlinked component directories inside the installed package', async () => {
    await installPlugin(await source('demo'));
    await fs.symlink(tmp, path.join(installedRoot('demo'), 'hooks'));
    const registry = await loadSkillRegistry(cwd);
    expect([...registry.skills.keys()]).toEqual(['demo:review']);
    expect(registry.errors).toEqual([]);
  });

  it('isolates invalid skills and manifests without disabling other plugins', async () => {
    const root = await source('demo');
    await write(root, 'skills/broken/SKILL.md', 'not frontmatter');
    await installPlugin(root);
    await installPlugin(await source('bad'));
    await write(installedRoot('bad'), 'plugin.json', '{');
    const registry = await loadSkillRegistry(cwd);
    expect([...registry.skills.keys()]).toEqual(['demo:review']);
    expect(registry.errors).toHaveLength(2);
  });

  it.each(['./../outside', '/outside', './skills/../../outside', [42]])('isolates invalid legacy declaration %j', async custom => {
    await installPlugin(await source('demo', custom, true));
    const registry = await loadSkillRegistry(cwd);
    expect([...registry.skills.keys()]).toEqual(['demo:review']);
    expect(registry.errors).toHaveLength(1);
  });

  it.each(['skill', 'custom'])('refuses package-escaping references from %s directories', async kind => {
    const root = await source('demo', kind === 'custom' ? './custom' : undefined, kind === 'custom');
    const base = kind === 'custom' ? 'custom' : 'skills';
    await write(root, `${base}/escaped/SKILL.md`, markdown('escaped', '[Guide](guide.md)'));
    await write(root, `${base}/escaped/guide.md`, 'Guide content');
    await installPlugin(root);
    const installed = installedRoot('demo');
    await fs.unlink(path.join(installed, base, 'escaped', 'guide.md'));
    await fs.symlink(path.join(cwd, 'outside/guide.md'), path.join(installed, base, 'escaped', 'guide.md'));
    const registry = await loadSkillRegistry(cwd);
    expect(registry.skills.has('demo:escaped')).toBe(false);
    expect(registry.skills.has('demo:review')).toBe(true);
  });

  it('does not activate unreceipted packages, Claude caches or collections', async () => {
    const root = await source('demo');
    for (const destination of [path.join(cwd, '.haze/plugins/demo'), path.join(cwd, '.claude/plugins/cache/demo'), path.join(cwd, 'collection')]) {
      await fs.mkdir(path.dirname(destination), {recursive: true});
      await fs.cp(root, destination, {recursive: true});
    }
    await write(cwd, '.claude-plugin/marketplace.json', JSON.stringify({plugins: [{name: 'demo', source: './collection'}]}));
    expect((await loadSkillRegistry(cwd)).skills.size).toBe(0);
  });

  it('does not reactivate changed package content retained after removal', async () => {
    await installPlugin(await source('demo'));
    await write(installedRoot('demo'), 'skills/review/SKILL.md', markdown('changed'));
    await write(installedRoot('demo'), 'plugin.json', JSON.stringify({$schema: PLUGIN_SCHEMA, name: 'demo', version: 'changed'}));
    const removed = await removePlugin('demo');
    expect(removed.retained).toContain('plugins/demo/skills/review/SKILL.md');
    expect((await loadSkillRegistry(cwd)).skills.size).toBe(0);
  });
});
