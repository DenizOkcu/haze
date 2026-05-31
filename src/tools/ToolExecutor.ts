import {pathToFileURL} from 'node:url';
import type {LoadedSkill, LoadedTool} from '../skills/types.js';
import type {ToolContext, ToolResult} from './types.js';

export async function executeTool(tool: LoadedTool, skill: LoadedSkill, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    const context: ToolContext = {cwd: process.cwd(), skillDir: skill.dir};
    const mod = await import(`${pathToFileURL(tool.absolutePath).href}?t=${Date.now()}`);
    if (typeof mod.execute !== 'function') {
      return {ok: false, message: 'Tool must export execute(input, context)'};
    }
    const result = await mod.execute(input ?? {}, context);
    return (result as ToolResult) ?? {ok: true};
  } catch (error) {
    return {ok: false, message: error instanceof Error ? error.message : String(error)};
  }
}
