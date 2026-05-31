import os from 'node:os';
import path from 'node:path';

export const HAZE_DIR = path.join(os.homedir(), '.haze');
export const GLOBAL_SKILLS_DIR = path.join(HAZE_DIR, 'skills');
export const MEMORY_FILE = path.join(HAZE_DIR, 'memory.json');
export const LOCAL_SKILLS_DIR = path.join(process.cwd(), '.haze', 'skills');
export const SKILL_CONFIG_DIR = path.join(HAZE_DIR, 'config', 'skills');

export function skillSearchDirs(): string[] {
  return [GLOBAL_SKILLS_DIR, LOCAL_SKILLS_DIR];
}
