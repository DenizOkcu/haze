import {afterEach, beforeEach, describe, it, expect} from 'vitest';
import fs from '../fsExtra.js';
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

describe('git internals protection across tools', () => {
  let tmp: string;
  let outer: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-git-test-'));
    outer = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-git-outer-'));
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

  const GIT_CONFIG = '[core]\n\trepositoryformatversion = 0\n';

  async function seedGitDir() {
    await fs.ensureDir(path.join(tmp, '.git', 'hooks'));
    await fs.outputFile(path.join(tmp, '.git', 'config'), GIT_CONFIG);
    await fs.outputFile(path.join(tmp, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  }

  it("writeFile refuses to create a new '.git/hooks/pre-commit' and leaves the tree unchanged", async () => {
    await seedGitDir();
    const result = await run(() => hazeTools.writeFile.execute({path: '.git/hooks/pre-commit', content: '#!/bin/sh\necho pwned\n'}, {abortSignal: undefined}));
    expect(result).toMatchObject({ok: false, reasonCode: 'git_internals_protected', recoverable: false});
    expect(result.suggestedNextStep).toContain('Ask the user');
    expect(result.suggestedNextStep).not.toContain('Keep each content chunk');
    await expect(fs.pathExists(path.join(tmp, '.git', 'hooks', 'pre-commit'))).resolves.toBe(false);
  });

  it("editFile refuses to modify '.git/config' and leaves it unchanged", async () => {
    await seedGitDir();
    const result = await run(() => hazeTools.editFile.execute({path: '.git/config', edits: [{oldText: '[core]', newText: '[core]\n\thooksPath = repo-hooks'}]}, {abortSignal: undefined}));
    expect(result).toMatchObject({ok: false, reasonCode: 'git_internals_protected', recoverable: false});
    await expect(fs.readFile(path.join(tmp, '.git', 'config'), 'utf8')).resolves.toBe(GIT_CONFIG);
  });

  it("readFile refuses '.git/config' and '.git/hooks/*' while other '.git' object reads stay allowed", async () => {
    await seedGitDir();
    await fs.outputFile(path.join(tmp, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
    for (const protectedPath of ['.git/config', '.git/hooks/pre-commit', '.git/credentials']) {
      const result = await run(() => hazeTools.readFile.execute({path: protectedPath}, {abortSignal: undefined}));
      expect(result, protectedPath).toMatchObject({ok: false, reasonCode: 'git_internals_protected', recoverable: false});
      expect(JSON.stringify(result), protectedPath).not.toContain('repositoryformatversion');
    }
    const head = await run(() => hazeTools.readFile.execute({path: '.git/HEAD'}, {abortSignal: undefined}));
    expect(head.ok).toBeUndefined();
    expect(head.content).toContain('refs/heads/main');
  });

  it('blocks a workspace symlink aliasing the git directory', async () => {
    await seedGitDir();
    await fs.symlink(path.join(tmp, '.git'), path.join(tmp, 'meta-link'));
    const result = await run(() => hazeTools.writeFile.execute({path: 'meta-link/hooks/pre-commit', content: '#!/bin/sh\n'}, {abortSignal: undefined}));
    expect(result).toMatchObject({ok: false, reasonCode: 'git_internals_protected', recoverable: false});
  });

  it('blocks mutations into a linked-worktree gitdir resolved through the gitdir pointer', async () => {
    // Mirrors a real linked-worktree layout: the workspace `.git` is a pointer
    // file and the internals live at paths without a `.git` segment, so only
    // pointer/commondir resolution can protect them.
    const gitDir = path.join(tmp, 'metadata', 'worktrees', 'app');
    const commonDir = path.join(tmp, 'metadata');
    await fs.ensureDir(path.join(gitDir, 'hooks'));
    await fs.ensureDir(path.join(commonDir, 'hooks'));
    await fs.outputFile(path.join(tmp, '.git'), `gitdir: ${gitDir}\n`);
    await fs.outputFile(path.join(gitDir, 'commondir'), '../..\n');
    const worktreeWrite = await run(() => hazeTools.writeFile.execute({path: 'metadata/worktrees/app/hooks/pre-commit', content: '#!/bin/sh\n'}, {abortSignal: undefined}));
    expect(worktreeWrite).toMatchObject({ok: false, reasonCode: 'git_internals_protected', recoverable: false});
    const commonWrite = await run(() => hazeTools.writeFile.execute({path: 'metadata/hooks/pre-commit', content: '#!/bin/sh\n'}, {abortSignal: undefined}));
    expect(commonWrite).toMatchObject({ok: false, reasonCode: 'git_internals_protected', recoverable: false});
  });

  it('blocks a blessed read of the repository git config from a linked worktree', async () => {
    // The workspace is the linked worktree; the real git dir lives outside it.
    // The blessing would normally skip the workspace boundary — the git
    // internals guard must refuse before the bless set is consulted.
    const worktree = path.join(tmp, 'wt');
    const mainGit = path.join(outer, 'main', '.git');
    const worktreeGitDir = path.join(mainGit, 'worktrees', 'wt');
    await fs.ensureDir(worktree);
    await fs.ensureDir(path.join(mainGit, 'hooks'));
    await fs.ensureDir(worktreeGitDir);
    await fs.outputFile(path.join(mainGit, 'config'), GIT_CONFIG);
    await fs.outputFile(path.join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`);
    await fs.outputFile(path.join(worktreeGitDir, 'commondir'), '../..\n');
    const context = {context: {blessedPaths: [{realPath: await fs.realpath(path.join(mainGit, 'config')), isDirectory: false}]}};
    const originalCwd = process.cwd();
    process.chdir(worktree);
    let result: unknown;
    try {
      result = await hazeTools.readFile.execute({path: path.join(mainGit, 'config')}, {abortSignal: undefined, context});
    } finally {
      process.chdir(originalCwd);
    }
    expect(result).toMatchObject({ok: false, reasonCode: 'git_internals_protected', recoverable: false});
    expect(JSON.stringify(result)).not.toContain('repositoryformatversion');
  });

  it('refuses mutations under *.git bare-repo directory names', async () => {
    await fs.ensureDir(path.join(tmp, 'backup.git', 'hooks'));
    const result = await run(() => hazeTools.writeFile.execute({path: 'backup.git/hooks/pre-receive', content: '#!/bin/sh\n'}, {abortSignal: undefined}));
    expect(result).toMatchObject({ok: false, reasonCode: 'git_internals_protected', recoverable: false});
    await expect(fs.pathExists(path.join(tmp, 'backup.git', 'hooks', 'pre-receive'))).resolves.toBe(false);
    // A file merely NAMED *.git (e.g. a bundle) is not a repository and stays writable.
    const bundle = await run(() => hazeTools.writeFile.execute({path: 'bundle.git', content: 'not a repo\n'}, {abortSignal: undefined}));
    expect(bundle).toMatchObject({ok: true, path: 'bundle.git'});
  });

  it("refuses reads of config/credentials at any depth under '.git/modules/**'", async () => {
    // Submodule gitdirs live under modules/; their config files carry
    // credential-bearing remote URLs and must not be readable back.
    for (const protectedPath of ['.git/modules/vendor/config', '.git/modules/vendor/worktrees/wt/config', '.git/modules/vendor/credentials']) {
      await fs.outputFile(path.join(tmp, ...protectedPath.split('/')), 'token material\n');
      const result = await run(() => hazeTools.readFile.execute({path: protectedPath}, {abortSignal: undefined}));
      expect(result, protectedPath).toMatchObject({ok: false, reasonCode: 'git_internals_protected', recoverable: false});
      expect(JSON.stringify(result), protectedPath).not.toContain('token material');
    }
  });

  it("editing '.gitignore' (the file, not the dir) still works", async () => {
    await seedGitDir();
    await fs.outputFile(path.join(tmp, '.gitignore'), 'node_modules\n');
    const result = await run(() => hazeTools.editFile.execute({path: '.gitignore', edits: [{oldText: 'node_modules', newText: 'node_modules\ndist'}]}, {abortSignal: undefined}));
    expect(result).toMatchObject({ok: true, path: '.gitignore'});
    await expect(fs.readFile(path.join(tmp, '.gitignore'), 'utf8')).resolves.toContain('dist');
  });
});

describe('hardlink-aware secret protection', () => {
  let tmp: string;
  let outer: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-hardlink-test-'));
    outer = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-hardlink-outer-'));
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

  const KEY_MATERIAL = 'FAKE_PRIVATE_KEY_MARKER_7\n';

  it('readFile refuses an innocent-named hardlink of a key file outside the workspace', async () => {
    const keyFile = path.join(outer, 'fixture-key');
    await fs.outputFile(keyFile, KEY_MATERIAL);
    await fs.link(keyFile, path.join(tmp, 'docs-notes.txt'));
    const result = await run(() => hazeTools.readFile.execute({path: 'docs-notes.txt'}, {abortSignal: undefined}));
    expect(result).toMatchObject({ok: false, reasonCode: 'multi_link_file_protected', recoverable: true});
    expect(result.suggestedNextStep).toContain('Ask the user');
    expect(JSON.stringify(result)).not.toContain('FAKE_PRIVATE_KEY_MARKER_7');
  });

  it('editFile refuses to modify a hardlinked file', async () => {
    const keyFile = path.join(outer, 'fixture-key');
    await fs.outputFile(keyFile, KEY_MATERIAL);
    await fs.link(keyFile, path.join(tmp, 'linked-config.txt'));
    const result = await run(() => hazeTools.editFile.execute({path: 'linked-config.txt', edits: [{oldText: 'FAKE', newText: 'public'}]}, {abortSignal: undefined}));
    expect(result).toMatchObject({ok: false, reasonCode: 'multi_link_file_protected', recoverable: true});
    await expect(fs.readFile(keyFile, 'utf8')).resolves.toBe(KEY_MATERIAL);
  });

  it('a normal single-link file is unaffected', async () => {
    await fs.outputFile(path.join(tmp, 'plain.txt'), 'regular content\n');
    const read = await run(() => hazeTools.readFile.execute({path: 'plain.txt'}, {abortSignal: undefined}));
    expect(read.ok).toBeUndefined();
    expect(read.content).toContain('regular content');
    const written = await run(() => hazeTools.writeFile.execute({path: 'fresh-dir/plain2.txt', content: 'new\n'}, {abortSignal: undefined}));
    expect(written).toMatchObject({ok: true, path: 'fresh-dir/plain2.txt'});
  });
});

describe('dangling symlink write protection', () => {
  let tmp: string;
  let outer: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-dangling-test-'));
    outer = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-dangling-outer-'));
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

  it("writeFile through a dangling symlink at git internals fails and creates nothing", async () => {
    // realpath fails on the dangling link, so every realpath-based guard sees
    // only the innocent link name — but fs.writeFile follows the link and
    // CREATES .git/hooks/pre-commit (hook persistence).
    await fs.ensureDir(path.join(tmp, '.git', 'hooks'));
    await fs.symlink('.git/hooks/pre-commit', path.join(tmp, 'dangly'));
    const result = await run(() => hazeTools.writeFile.execute({path: 'dangly', content: '#!/bin/sh\necho pwned\n'}, {abortSignal: undefined}));
    expect(result).toMatchObject({ok: false, reasonCode: 'git_internals_protected', recoverable: false});
    await expect(fs.pathExists(path.join(tmp, '.git', 'hooks', 'pre-commit'))).resolves.toBe(false);
  });

  it('writeFile through a dangling symlink escaping the workspace fails and creates nothing outside', async () => {
    await fs.symlink(path.join(outer, 'outside-marker'), path.join(tmp, 'escape'));
    const result = await run(() => hazeTools.writeFile.execute({path: 'escape', content: 'exfiltrated\n'}, {abortSignal: undefined}));
    expect(result).toMatchObject({ok: false, reasonCode: 'outside_workspace', recoverable: true});
    expect(result.error).toContain('outside the workspace');
    expect(result.suggestedNextStep).toContain('Ask the user');
    await expect(fs.pathExists(path.join(outer, 'outside-marker'))).resolves.toBe(false);
  });

  it('a legit overwrite through a symlink to an existing inside-workspace file still works', async () => {
    await fs.outputFile(path.join(tmp, 'real.txt'), 'original\n');
    await fs.symlink('real.txt', path.join(tmp, 'alias.txt'));
    const result = await run(() => hazeTools.writeFile.execute({path: 'alias.txt', content: 'replacement\n', overwriteExisting: true}, {abortSignal: undefined}));
    expect(result).toMatchObject({ok: true, path: 'alias.txt'});
    await expect(fs.readFile(path.join(tmp, 'real.txt'), 'utf8')).resolves.toBe('replacement\n');
  });
});

function SUPER_SECRET_PATTERN() {
  return 'SUPER_SECRET_MARKER_42';
}
