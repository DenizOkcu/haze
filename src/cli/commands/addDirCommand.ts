import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {isProtectedSecretPath} from '../../core/safety/secretPaths.js';
import type {PromptSession} from '../../llm/systemPrompt.js';
import type {CommandContext, CommandResult} from './commands.js';

/**
 * `/add-dir` — session-scoped extended workspace directories, modeled on the
 * familiar interactive-agent pattern but on haze's trust rules: the path is
 * explicit user intent (typed in the chat, like an `@path` mention), so file
 * tools may read AND mutate inside it and sandboxed shell commands get it as
 * a read-write root — for the current session only, kept in memory on the
 * `PromptSession`, never written to settings. Protected-secret paths are
 * refused exactly like sandbox grants; `/add-dir reset` clears the list.
 * Applies from the next turn (the boundary and context are built per
 * attempt in `attemptSetup`).
 */

export type AddDirResult =
  | {action: 'status'; message: string}
  | {action: 'add'; dirs: NonNullable<PromptSession['addedDirs']>; message: string}
  | {action: 'reset'; message: string}
  | {action: 'error'; message: string};

function expand(raw: string, cwd: string, homedir: string): string {
  if (raw === '~') return homedir;
  if (raw.startsWith('~/')) return path.join(homedir, raw.slice(2));
  return path.resolve(cwd, raw);
}

function describeList(dirs: NonNullable<PromptSession['addedDirs']>, homedir: string): string {
  if (dirs.length === 0) return 'No session directories added.';
  const short = (value: string) => value === homedir ? '~' : value.startsWith(`${homedir}/`) ? `~${value.slice(homedir.length)}` : value;
  return dirs.map(dir => `  ${short(dir.realPath)}`).join('\n');
}

/** Pure result function shared by the slash path and tests. */
export async function resolveAddDirCommand(args: string, input: {current?: PromptSession['addedDirs']; cwd: string; homedir?: string}): Promise<AddDirResult> {
  const homedir = input.homedir ?? os.homedir();
  const current = input.current ?? [];
  const value = args.trim();
  if (!value) {
    return {action: 'status', message: `${describeList(current, homedir)}\nUsage: /add-dir <directory> — extends the workspace with a directory for this session: file tools may read and edit inside it, shell commands may read and write there. Not persisted; /add-dir reset clears the list.`};
  }
  if (value.toLowerCase() === 'reset') {
    if (current.length === 0) return {action: 'status', message: 'No session directories to clear.'};
    return {action: 'reset', message: `Removed ${current.length} session director${current.length === 1 ? 'y' : 'ies'}. Workspace confinement applies again from the next turn.`};
  }

  const expanded = expand(value, input.cwd, homedir);
  if (isProtectedSecretPath(expanded, homedir)) {
    return {action: 'error', message: `Refusing to add "${value}": it resolves to a protected secret path. Secret files can never be added to the session; copy the specific value you need into the workspace instead.`};
  }
  let realPath: string;
  let isDirectory: boolean;
  try {
    const stats = await fs.stat(expanded);
    realPath = await fs.realpath(expanded);
    isDirectory = stats.isDirectory();
  } catch {
    return {action: 'error', message: `Directory not found: ${value}. /add-dir takes an existing directory (absolute, ~, or workspace-relative).`};
  }
  if (!isDirectory) {
    return {action: 'error', message: `Not a directory: ${value}. /add-dir takes a directory; bless a single file with an @mention in the prompt instead.`};
  }
  if (isProtectedSecretPath(realPath, homedir)) {
    return {action: 'error', message: `Refusing to add "${value}": it resolves to a protected secret path. Secret files can never be added to the session.`};
  }
  if (current.some(dir => dir.realPath === realPath)) {
    return {action: 'status', message: `Already added this session:\n${describeList(current, homedir)}`};
  }
  return {
    action: 'add',
    dirs: [...current, {realPath, isDirectory: true}],
    message: `Added ${realPath} for this session: file tools may read and edit inside it, shell commands may read and write there (sandboxed as a read-write root). Not written to settings; applies from the next turn; /add-dir reset clears it.`,
  };
}

export async function handleAddDirCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  const result = await resolveAddDirCommand(args, {current: ctx.getAddedDirs?.(), cwd: process.cwd()});
  if (result.action === 'add') ctx.setAddedDirs?.(result.dirs);
  if (result.action === 'reset') ctx.setAddedDirs?.([]);
  ctx.addSystemMessage(result.message);
  return 'handled';
}
