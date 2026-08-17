import {afterEach, beforeEach, describe, it, expect} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {hazeTools} from '../../src/llm/hazeTools.js';

describe('secret file protection across tools', () => {
  let tmp: string;
  let outer: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-test-'));
    outer = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-outer-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
    await fs.remove(outer);
  });

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    const originalCwd = process.cwd();
    process.chdir(tmp);
    try {
      return await fn();
    } finally {
      process.chdir(originalCwd);
    }
  }

  const SECRET = 'SUPER_SECRET_MARKER_42';

  async function seedWorkspace() {
    await fs.outputFile(path.join(tmp, '.env'), `${SECRET}=1\n`);
    await fs.outputFile(path.join(tmp, 'sub/.env'), `${SECRET}=2\n`);
    await fs.outputFile(path.join(tmp, '.env.local'), `${SECRET}=3\n`);
    await fs.outputFile(path.join(tmp, '.zsh_history'), `cmd ${SECRET}\n`);
    await fs.outputFile(path.join(tmp, '.env.example'), `DOC=${SECRET}\n`);
    await fs.outputFile(path.join(tmp, 'notes.txt'), `mentions ${SECRET} in docs\n`);
  }

  it('readFile refuses .env and never echoes its content', async () => {
    await seedWorkspace();
    const result = await run(() => hazeTools.readFile.execute({path: '.env'}, {abortSignal: undefined}));
    expect(result).toMatchObject({ok: false, reasonCode: 'secret_file_protected', recoverable: false});
    expect(result.suggestedNextStep).toContain('Ask the user');
    expect(result.suggestedNextStep).not.toContain('retry replaceLines');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('readFile refuses other protected names (.env.local, shell history, keys)', async () => {
    await seedWorkspace();
    await fs.outputFile(path.join(tmp, 'server.pem'), `-----BEGIN PRIVATE KEY-----${SECRET}`);
    await fs.outputFile(path.join(tmp, 'id_ed25519'), SECRET);
    for (const protectedPath of ['.env.local', '.zsh_history', 'server.pem', 'id_ed25519', 'sub/.env']) {
      const result = await run(() => hazeTools.readFile.execute({path: protectedPath}, {abortSignal: undefined}));
      expect(result, protectedPath).toMatchObject({ok: false, reasonCode: 'secret_file_protected'});
      expect(JSON.stringify(result), protectedPath).not.toContain(SECRET);
    }
  });

  it('readFile still reads documentation variants like .env.example', async () => {
    await seedWorkspace();
    const result = await run(() => hazeTools.readFile.execute({path: '.env.example'}, {abortSignal: undefined}));
    expect(result.ok).toBeUndefined();
    expect(result.content).toContain(`DOC=${SECRET}`);
  });

  it('readFile refuses a blessed outside-workspace secret even though the user mentioned it', async () => {
    const secretFile = path.join(outer, '.env');
    await fs.outputFile(secretFile, `${SECRET}=outer\n`);
    const context = {context: {blessedPaths: [{realPath: await fs.realpath(secretFile), isDirectory: false}]}};
    const result = await run(() => hazeTools.readFile.execute({path: secretFile}, {abortSignal: undefined, context}));
    expect(result).toMatchObject({ok: false, reasonCode: 'secret_file_protected'});
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('readFile refuses a symlink renamed onto a secret and a secret name pointing elsewhere', async () => {
    await seedWorkspace();
    await fs.symlink(path.join(tmp, '.env'), path.join(tmp, 'alias-link.txt'));
    await fs.ensureDir(path.join(tmp, 'redirect'));
    await fs.symlink(path.join(tmp, 'notes.txt'), path.join(tmp, 'redirect/.env'));
    const viaLink = await run(() => hazeTools.readFile.execute({path: 'alias-link.txt'}, {abortSignal: undefined}));
    expect(viaLink).toMatchObject({ok: false, reasonCode: 'secret_file_protected'});
    const viaName = await run(() => hazeTools.readFile.execute({path: 'redirect/.env'}, {abortSignal: undefined}));
    expect(viaName).toMatchObject({ok: false, reasonCode: 'secret_file_protected'});
  });

  it('editFile and replaceLines refuse to modify protected files and leave them unchanged', async () => {
    await seedWorkspace();
    const edit = await run(() => hazeTools.editFile.execute({path: '.env', edits: [{oldText: SECRET, newText: 'x'}]}, {abortSignal: undefined}));
    expect(edit).toMatchObject({ok: false, reasonCode: 'secret_file_protected', recoverable: false});
    // The refusal must carry its own next step — the generic edit-recovery hint
    // ("read the file again, then retry") would misdirect the model into
    // retrying the refused access.
    expect(edit.suggestedNextStep).toContain('Ask the user');
    expect(edit.suggestedNextStep).not.toContain('Read the file again');
    const replace = await run(() => hazeTools.replaceLines.execute({path: '.zsh_history', startLine: 1, endLine: 1, content: 'noop'}, {abortSignal: undefined}));
    expect(replace).toMatchObject({ok: false, reasonCode: 'secret_file_protected', recoverable: false});
    expect(replace.suggestedNextStep).toContain('Ask the user');
    await expect(fs.readFile(path.join(tmp, '.env'), 'utf8')).resolves.toBe(`${SECRET}=1\n`);
  });

  it('writeFile refuses to create, overwrite, or append protected files', async () => {
    await seedWorkspace();
    const create = await run(() => hazeTools.writeFile.execute({path: 'fresh.pem', content: 'key material'}, {abortSignal: undefined}));
    expect(create).toMatchObject({ok: false, reasonCode: 'secret_file_protected', recoverable: false});
    expect(create.suggestedNextStep).toContain('Ask the user');
    const append = await run(() => hazeTools.writeFile.execute({path: '.env', content: 'MORE=1', append: true}, {abortSignal: undefined}));
    expect(append).toMatchObject({ok: false, reasonCode: 'secret_file_protected', recoverable: false});
    await expect(fs.readFile(path.join(tmp, '.env'), 'utf8')).resolves.toBe(`${SECRET}=1\n`);
    await expect(fs.pathExists(path.join(tmp, 'fresh.pem'))).resolves.toBe(false);
  });

  it('grep traversal skips protected files (documentation variants included)', async () => {
    await seedWorkspace();
    const result = await run(() => hazeTools.grep.execute({pattern: SUPER_SECRET_PATTERN(), path: '.', contextLines: 0, maxMatches: 50, caseInsensitive: false, includeIgnored: false}, {abortSignal: undefined}));
    const matchedFiles = [...new Set(result.matches.map((match: {file: string}) => match.file))].sort();
    expect(matchedFiles).toEqual(['notes.txt']);
    expect(result.totalMatches).toBe(1);
  });

  it('grep cannot re-include secrets with an explicit glob', async () => {
    await seedWorkspace();
    const result = await run(() => hazeTools.grep.execute({pattern: SUPER_SECRET_PATTERN(), path: '.', glob: '.env*', contextLines: 0, maxMatches: 50, caseInsensitive: false, includeIgnored: false}, {abortSignal: undefined}));
    expect(result.matches).toEqual([]);
    expect(result.totalMatches).toBe(0);
  });

  it('listFiles still lists protected names for transparency', async () => {
    await seedWorkspace();
    const result = await run(() => hazeTools.listFiles.execute({path: '.', recursive: false, maxEntries: 100, includeIgnored: false, includeSizes: false}, {abortSignal: undefined}));
    expect(JSON.stringify(result)).toContain('.env');
  });

  it('shell is deliberately not part of secret enforcement — commands execute unfiltered', async () => {
    await seedWorkspace();
    const result = await run(() => hazeTools.shell.execute({command: 'cat .env.example'}, {abortSignal: undefined}));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).toContain(`DOC=${SECRET}`);
  });
});

function SUPER_SECRET_PATTERN() {
  return 'SUPER_SECRET_MARKER_42';
}
