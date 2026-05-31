import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {LoadedSkill, LoadedTool} from '../skills/types.js';
import type {ToolContext, ToolResult} from './types.js';

export class ToolExecutor {
  async execute(tool: LoadedTool, skill: LoadedSkill, input: Record<string, unknown>): Promise<ToolResult> {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const runner = path.join(here, path.basename(fileURLToPath(import.meta.url)).endsWith('.ts') ? 'toolRunner.ts' : 'toolRunner.js');
    const context: ToolContext = {cwd: process.cwd(), skillDir: skill.dir};
    const child = spawn('npx', ['tsx', runner, tool.absolutePath, JSON.stringify(input ?? {}), JSON.stringify(context)], {cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    try {
      const parsed = JSON.parse(stdout || '{}') as ToolResult;
      if (code !== 0 && parsed.ok !== false) return {ok: false, message: stderr || `Tool exited with ${code}`, data: parsed};
      return parsed;
    } catch {
      return {ok: code === 0, message: code === 0 ? stdout : stderr || stdout, data: {stdout, stderr, code}};
    }
  }
}
