import os from 'node:os';
import path from 'node:path';

export const HAZE_DIR = path.join(os.homedir(), '.haze');
export const GLOBAL_SKILLS_DIR = path.join(HAZE_DIR, 'skills');
