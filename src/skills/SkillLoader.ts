import fs from 'fs-extra';
import path from 'node:path';
import {readYaml} from '../utils/yaml.js';
import {skillManifestSchema} from './manifestSchema.js';
import type {LoadedSkill, LoadedTool, SkillManifest} from './types.js';

export class SkillLoader {
  async loadSkill(dir: string, source: 'global' | 'local'): Promise<LoadedSkill | null> {
    const manifestPath = path.join(dir, 'skill.yaml');
    if (!(await fs.pathExists(manifestPath))) return null;
    const raw = await readYaml<SkillManifest>(manifestPath);
    const manifest = skillManifestSchema.parse(raw) as SkillManifest;
    const prompts = await Promise.all((manifest.prompts ?? []).map(async p => {
      const absolutePath = path.resolve(dir, p.path);
      return {...p, absolutePath, content: await fs.readFile(absolutePath, 'utf8')};
    }));
    const tools: LoadedTool[] = (manifest.tools ?? []).map(t => ({
      ...t,
      id: `${manifest.name}.${t.name}`,
      skillName: manifest.name,
      absolutePath: path.resolve(dir, t.path)
    }));
    return {dir, manifestPath, manifest, prompts, tools, source};
  }
}
