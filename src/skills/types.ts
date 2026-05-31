export interface JsonSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema & {description?: string}>;
  items?: JsonSchema;
  description?: string;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  dependencies?: {
    cli?: {name: string; description?: string; required?: boolean}[];
    env?: {name: string; description?: string; required?: boolean}[];
  };
  tools?: SkillToolManifest[];
  prompts?: SkillPromptManifest[];
}

export interface SkillToolManifest {
  name: string;
  description: string;
  path: string;
  input?: JsonSchema;
}

export interface SkillPromptManifest {
  name: string;
  description?: string;
  path: string;
}

export interface LoadedSkill {
  dir: string;
  manifestPath: string;
  manifest: SkillManifest;
  prompts: LoadedPrompt[];
  tools: LoadedTool[];
  source: 'global' | 'local';
}

export interface LoadedPrompt extends SkillPromptManifest { content: string; absolutePath: string }
export interface LoadedTool extends SkillToolManifest { id: string; skillName: string; absolutePath: string }
