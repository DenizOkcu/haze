import {afterEach, beforeEach, describe, it, expect} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {hazeTools} from '../../src/llm/hazeTools.js';

describe('readFile tool', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  async function readFile(params: {path: string; offset?: number; limit?: number; mode?: 'exact' | 'outline'}, experimental_context?: unknown) {
    const originalCwd = process.cwd();
    process.chdir(tmp);
    try {
      return await hazeTools.readFile.execute(params, {abortSignal: undefined, experimental_context});
    } finally {
      process.chdir(originalCwd);
    }
  }

  it('reads an entire file', async () => {
    await fs.writeFile(path.join(tmp, 'test.txt'), 'line1\nline2\nline3\n');
    const result = await readFile({path: 'test.txt'});
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(4);
    expect(result.totalLines).toBe(4); // trailing newline adds empty line
    expect(result.content).toContain('line1');
    expect(result.content).toContain('line3');
    expect(result).not.toHaveProperty('text');
    expect(result).not.toHaveProperty('lineNumberedText');
  });

  it('reads from offset', async () => {
    await fs.writeFile(path.join(tmp, 'test.txt'), 'a\nb\nc\nd\ne\n');
    const result = await readFile({path: 'test.txt', offset: 3});
    expect(result.startLine).toBe(3);
    expect(result.content).toContain('c');
    expect(result.content).not.toContain('a');
  });

  it('reads with limit', async () => {
    await fs.writeFile(path.join(tmp, 'test.txt'), 'a\nb\nc\nd\ne\n');
    const result = await readFile({path: 'test.txt', offset: 2, limit: 2});
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(3);
    expect(result.content).toContain('b');
    expect(result.content).toContain('c');
    expect(result.content).not.toContain('a');
    expect(result.content).not.toContain('d');
  });

  it('includes line numbers in output', async () => {
    await fs.writeFile(path.join(tmp, 'test.txt'), 'hello\nworld\n');
    const result = await readFile({path: 'test.txt'});
    expect(result.content).toMatch(/1.*hello/);
    expect(result.content).toMatch(/2.*world/);
  });

  it('defaults to a bounded page and returns the next offset', async () => {
    await fs.writeFile(path.join(tmp, 'large.txt'), Array.from({length: 350}, (_, index) => `line-${index + 1}`).join('\n'));
    const result = await readFile({path: 'large.txt'});
    expect(result.endLine).toBe(300);
    expect(result.nextOffset).toBe(301);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('line-300');
    expect(result.content).not.toContain('line-301');
  });

  it('caps very long numbered output', async () => {
    await fs.writeFile(path.join(tmp, 'long.txt'), 'x'.repeat(60_000));
    const result = await readFile({path: 'long.txt'});
    expect(result.content.length).toBeLessThanOrEqual(50_000);
    expect(result.lineTruncated).toBe(true);
  });

  it('returns source outlines for discovery without replacing exact reads', async () => {
    await fs.writeFile(path.join(tmp, 'app.py'), [
      'import os',
      '',
      'CONSTANT = 1',
      '',
      'def build_app():',
      '    return object()',
      '',
      'class Service:',
      '    def run(self):',
      '        return True',
    ].join('\n'));
    const result = await readFile({path: 'app.py', mode: 'outline'});
    expect(result.mode).toBe('outline');
    expect(result.content).toContain('import os');
    expect(result.content).toContain('def build_app');
    expect(result.content).toContain('class Service');
    expect(result.content).not.toContain('return object()');
    expect(result.warning).toContain('Use exact readFile');
  });

  it('returns scoped instructions for nested paths once', async () => {
    await fs.outputFile(path.join(tmp, 'pkg/CLAUDE.md'), 'pkg rules');
    await fs.outputFile(path.join(tmp, 'pkg/src/a.ts'), 'export const a = 1;');
    const context = {loadedContextFilePaths: new Set<string>()};

    const first = await readFile({path: 'pkg/src/a.ts'}, context);
    const second = await readFile({path: 'pkg/src/a.ts'}, context);

    expect(first.applicableProjectInstructions).toEqual([{path: 'pkg/CLAUDE.md', content: 'pkg rules'}]);
    expect(second).not.toHaveProperty('applicableProjectInstructions');
  });

  it('returns structured failure for nonexistent file', async () => {
    const result = await readFile({path: 'nope.txt'});
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('writeFile tool', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  async function writeFile(params: {path: string; content: string; overwriteExisting?: boolean}, experimental_context?: unknown) {
    const originalCwd = process.cwd();
    process.chdir(tmp);
    try {
      return await hazeTools.writeFile.execute(params, {abortSignal: undefined, experimental_context});
    } finally {
      process.chdir(originalCwd);
    }
  }

  it('creates a new file', async () => {
    const result = await writeFile({path: 'new.txt', content: 'hello'});
    expect(result.ok).toBe(true);
    expect(result.path).toBe('new.txt');
    const content = await fs.readFile(path.join(tmp, 'new.txt'), 'utf8');
    expect(content).toBe('hello');
  });

  it('returns structured failure when overwriting an existing file without explicit approval', async () => {
    await fs.writeFile(path.join(tmp, 'existing.txt'), 'old');
    const result = await writeFile({path: 'existing.txt', content: 'new'});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Refusing to overwrite existing file');
    const content = await fs.readFile(path.join(tmp, 'existing.txt'), 'utf8');
    expect(content).toBe('old');
  });

  it('overwrites an existing file with explicit approval', async () => {
    await fs.writeFile(path.join(tmp, 'existing.txt'), 'old');
    await writeFile({path: 'existing.txt', content: 'new', overwriteExisting: true});
    const content = await fs.readFile(path.join(tmp, 'existing.txt'), 'utf8');
    expect(content).toBe('new');
  });

  it('creates parent directories', async () => {
    const result = await writeFile({path: 'deep/nested/dir/file.txt', content: 'deep'});
    expect(result.ok).toBe(true);
    const content = await fs.readFile(path.join(tmp, 'deep', 'nested', 'dir', 'file.txt'), 'utf8');
    expect(content).toBe('deep');
  });

  it('stops before writing when new scoped instructions apply', async () => {
    await fs.outputFile(path.join(tmp, 'pkg/AGENTS.md'), 'pkg rules');
    const context = {loadedContextFilePaths: new Set<string>()};

    const result = await writeFile({path: 'pkg/src/a.ts', content: 'export const a = 1;'}, context);

    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe('scoped_instructions_discovered');
    expect(result.applicableProjectInstructions).toEqual([{path: 'pkg/AGENTS.md', content: 'pkg rules'}]);
    expect(await fs.pathExists(path.join(tmp, 'pkg/src/a.ts'))).toBe(false);
  });

  it('reports byte count', async () => {
    const result = await writeFile({path: 'bytes.txt', content: 'hello'});
    expect(result.bytes).toBe(5);
  });

  it('reports correct bytes for UTF-8 multibyte', async () => {
    const result = await writeFile({path: 'utf8.txt', content: 'ü'});
    expect(result.bytes).toBe(Buffer.byteLength('ü', 'utf8'));
  });
});
