export interface SkillFrontmatter {
  name: string;
  description: string;
}

export interface LoadedSkillReference {
  path: string;
  absolutePath: string;
  content: string;
}

export interface LoadedSkill {
  dir: string;
  path: string;
  name: string;
  description: string;
  body: string;
  references: LoadedSkillReference[];
  source: 'global';
}

export interface SkillRegistry {
  skills: Map<string, LoadedSkill>;
}
