export interface SkillFrontmatter {
  name: string;
  description: string;
}

export interface LoadedSkillReference {
  path: string;
  absolutePath: string;
  content: string;
}

export type SkillSource = 'global' | 'project';

export interface LoadedSkill {
  dir: string;
  path: string;
  name: string;
  description: string;
  body: string;
  references: LoadedSkillReference[];
  source: SkillSource;
}

export interface SkillRegistryError {
  directory: string;
  message: string;
  source?: SkillSource;
}

export interface SkillRegistry {
  /** Active skills before settings are applied; project skills win collisions. */
  skills: Map<string, LoadedSkill>;
  /** Every valid, selectable skill, including shadowed global skills. */
  candidates?: LoadedSkill[];
  errors: SkillRegistryError[];
}
