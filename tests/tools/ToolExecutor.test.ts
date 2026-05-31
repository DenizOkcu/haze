import {afterEach, beforeEach, describe, it, expect} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {executeTool} from '../../src/tools/ToolExecutor.js';
import type {LoadedSkill, LoadedTool} from '../../src/skills/types.js';

describe('executeTool', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  function makeTool(toolPath: string): LoadedTool {
    return {
      name: 'test-tool',
      description: 'A test tool',
      path: path.relative(tmp, toolPath),
      id: 'skill.test-tool',
      skillName: 'skill',
      absolutePath: toolPath,
    };
  }

  function makeSkill(dir: string): LoadedSkill {
    return {
      dir,
      manifestPath: path.join(dir, 'skill.yaml'),
      manifest: {name: 'skill', version: '1.0', description: 'test'},
      prompts: [],
      tools: [],
      source: 'local',
    };
  }

  it('executes a valid tool module', async () => {
    const toolFile = path.join(tmp, 'tool.js');
    await fs.writeFile(toolFile, `
      export function execute(input, context) {
        return {ok: true, echo: input.message};
      }
    `);
    const result = await executeTool(makeTool(toolFile), makeSkill(tmp), {message: 'hi'});
    expect(result.ok).toBe(true);
    if ('echo' in result) expect((result as {echo: string}).echo).toBe('hi');
  });

  it('returns error when tool has no execute export', async () => {
    const toolFile = path.join(tmp, 'no-exec.js');
    await fs.writeFile(toolFile, `export const foo = 42;`);
    const result = await executeTool(makeTool(toolFile), makeSkill(tmp), {});
    expect(result.ok).toBe(false);
    expect(result.message).toContain('must export execute');
  });

  it('returns error when tool throws', async () => {
    const toolFile = path.join(tmp, 'throw.js');
    await fs.writeFile(toolFile, `
      export function execute() { throw new Error('boom'); }
    `);
    const result = await executeTool(makeTool(toolFile), makeSkill(tmp), {});
    expect(result.ok).toBe(false);
    expect(result.message).toBe('boom');
  });

  it('passes context with cwd and skillDir', async () => {
    const toolFile = path.join(tmp, 'ctx.js');
    await fs.writeFile(toolFile, `
      export function execute(input, context) {
        return {ok: true, cwd: context.cwd, skillDir: context.skillDir};
      }
    `);
    const result = await executeTool(makeTool(toolFile), makeSkill(tmp), {});
    expect(result.ok).toBe(true);
    if ('cwd' in result) expect((result as {cwd: string}).cwd).toBe(process.cwd());
    if ('skillDir' in result) expect((result as {skillDir: string}).skillDir).toBe(tmp);
  });

  it('returns ok:true when tool returns undefined', async () => {
    const toolFile = path.join(tmp, 'void.js');
    await fs.writeFile(toolFile, `
      export function execute() {}
    `);
    const result = await executeTool(makeTool(toolFile), makeSkill(tmp), {});
    expect(result.ok).toBe(true);
  });

  it('busts cache with timestamp query parameter', async () => {
    const toolFile = path.join(tmp, 'cache.js');
    await fs.writeFile(toolFile, `export function execute() { return {ok: true}; }`);
    const result = await executeTool(makeTool(toolFile), makeSkill(tmp), {});
    expect(result.ok).toBe(true);
  });
});
