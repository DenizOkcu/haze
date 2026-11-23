import {tool, type ToolSet} from 'ai';
import {z} from 'zod';
import path from 'node:path';
import fs from 'node:fs/promises';
import {prepareWorkspaceWritePath} from './workspaceFile.js';
import {runBoundedProcess} from '../../core/process/runBoundedProcess.js';
import {SHELL_STREAM_BYTES} from '../../core/limits.js';
import {workspaceRoot} from '../../utils/path.js';
import {hazeToolContextSchema, runDedupedTool} from './toolContext.js';
import {HazeToolError, structuredToolFailure} from './failures.js';

/**
 * Dedicated git tools: compact, structured, bounded answers about the
 * workspace repository (and explicit mutating actions) instead of raw
 * `git` shell output. All tools run `git` in the workspace repo root through
 * the shared bounded subprocess primitive.
 */

export const GIT_LOG_DEFAULT_LIMIT = 20;
const GIT_LOG_MAX_LIMIT = 200;
export const GIT_DIFF_DEFAULT_LINES = 200;
const GIT_DIFF_MAX_LINES = 2000;
const GIT_TIMEOUT_MS = 30_000;

type GitFailure = ReturnType<typeof structuredToolFailure>;

function gitFailure(toolName: string, error: unknown, fallbackNextStep: string): GitFailure {
  return structuredToolFailure(toolName, error, fallbackNextStep);
}

/** Resolve the workspace repo root; throws a terminal not_a_repository error. */
async function resolveRepoRoot(): Promise<string> {
  const cwd = workspaceRoot();
  const result = await runBoundedProcess({
    command: 'git', args: ['rev-parse', '--show-toplevel'], cwd,
    timeoutMs: 10_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 64 * 1024,
  });
  const root = result.stdout.text.trim();
  if (result.code !== 0 || !root) {
    throw new HazeToolError('The current working directory is not inside a git repository.', 'not_a_repository', {
      recoverable: false,
      suggestedNextStep: 'Run git tools from inside a git repository, or use shell for non-git work.',
    });
  }
  return path.resolve(root);
}

/** Confine a user-supplied path to the workspace repo. */
function confinePath(repoRoot: string, inputPath: string): string {
  const resolved = path.resolve(repoRoot, inputPath);
  const confined = resolved === repoRoot || resolved.startsWith(repoRoot + path.sep);
  if (!confined) {
    throw new HazeToolError(`Path ${inputPath} is outside the workspace repository.`, 'outside_workspace', {
      recoverable: false,
      suggestedNextStep: 'Use a workspace-relative path.',
    });
  }
  if (resolved.split(path.sep).includes('.git')) {
    throw new HazeToolError(`Path ${inputPath} points into .git internals.`, 'git_internals_protected', {
      recoverable: false,
      suggestedNextStep: 'Query repository content, not .git internals; use shell only for explicitly requested raw git plumbing.',
    });
  }
  return path.relative(repoRoot, resolved) || '.';
}

interface GitRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

async function runGit(repoRoot: string, args: string[], abortSignal?: AbortSignal): Promise<GitRun> {
  const result = await runBoundedProcess({
    command: 'git', args, cwd: repoRoot, timeoutMs: GIT_TIMEOUT_MS, signal: abortSignal,
    maxStdoutBytes: SHELL_STREAM_BYTES, maxStderrBytes: SHELL_STREAM_BYTES,
  });
  return {code: result.code, stdout: result.stdout.text, stderr: result.stderr.text, timedOut: result.timedOut, aborted: result.aborted};
}

function gitError(toolName: string, run: GitRun, nextStep: string): GitFailure {
  const detail = run.stderr.trim().split('\n')[0] ?? `git exited with code ${run.code ?? 'null'}`;
  return {
    ok: false,
    toolName,
    path: undefined,
    error: detail,
    reasonCode: 'git_error' as const,
    recoverable: true,
    suggestedNextStep: nextStep,
    recoveryTool: undefined,
    recoveryInput: undefined,
  };
}

function abortedResult(toolName: string) {
  return {ok: false as const, toolName, reasonCode: 'aborted' as const, recoverable: true, error: 'Aborted.', suggestedNextStep: 'Retry when the turn is active.'};
}

const statusInput = z.object({
  path: z.string().optional().describe('Optional workspace-relative path to limit the status to.'),
});

const logInput = z.object({
  limit: z.number().int().min(1).max(GIT_LOG_MAX_LIMIT).default(GIT_LOG_DEFAULT_LIMIT).describe(`Max commits to return (default ${GIT_LOG_DEFAULT_LIMIT}).`),
  range: z.string().optional().describe('Optional commit range, e.g. HEAD~5..HEAD.'),
  path: z.string().optional().describe('Optional workspace-relative path to limit history to.'),
});

const diffInput = z.object({
  path: z.string().optional().describe('Optional workspace-relative file or directory to diff.'),
  range: z.string().optional().describe('Optional commit range to diff (e.g. HEAD~3..HEAD).'),
  staged: z.boolean().default(false).describe('Diff staged changes instead of unstaged.'),
  limit: z.number().int().min(1).max(GIT_DIFF_MAX_LINES).default(GIT_DIFF_DEFAULT_LINES).describe(`Max diff lines to return (default ${GIT_DIFF_DEFAULT_LINES}).`),
});

const branchInput = z.object({
  remotes: z.boolean().default(false).describe('Include remote branches.'),
});

const remoteInput = z.object({
  remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional().describe('Configured remote name; omit to use Git defaults.'),
});
const pullInput = remoteInput.extend({
  mode: z.enum(['ff-only', 'rebase', 'merge']).default('ff-only').describe('Integration policy; defaults to fast-forward only.'),
});
const cloneInput = z.object({
  url: z.string().min(1).describe('Remote repository URL (HTTPS, SSH, or git://); do not include credentials.'),
  path: z.string().min(1).describe('New workspace-relative destination directory.'),
});

async function runNetworkGit(cwd: string, args: string[], signal?: AbortSignal) {
  const result = await runBoundedProcess({
    command: 'git', args: ['-c', 'credential.interactive=never', '-c', 'protocol.ext.allow=never', ...args], cwd,
    timeoutMs: 120_000, signal, maxStdoutBytes: 8192, maxStderrBytes: 8192,
    // LC_ALL pins git's diagnostics to English so failure classification does not depend on the user's language.
    env: {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_MERGE_AUTOEDIT: 'no', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes', LC_ALL: 'C'},
  });
  return result;
}

function networkFailure(toolName: string, timedOut: boolean) {
  return {ok: false as const, toolName, reasonCode: 'git_error' as const, recoverable: true,
    error: timedOut ? 'Git network operation timed out.' : 'Git network operation failed.',
    suggestedNextStep: 'Check the remote, network, credentials, and repository state; authentication must be non-interactive.'};
}

/** Reasons for a failed `git pull`, in precedence order, matched against C-locale git diagnostics (see `runNetworkGit`). */
const PULL_FAILURE_REASONS: ReadonlyArray<readonly [pattern: RegExp, reason: string]> = [
  [/not possible to fast-forward|ca(?:not|n't) (?:be )?fast-forward(?:ed)?|divergent branches|fetch first/i, 'The branch cannot be fast-forwarded.'],
  [/CONFLICT|merge conflict/i, 'Pull stopped with conflicts.'],
];

/** Classify combined `git pull` stdout + stderr into a user-facing reason, or `undefined` when unrecognized. */
export function classifyPullFailure(output: string): string | undefined {
  return PULL_FAILURE_REASONS.find(([pattern]) => pattern.test(output))?.[1];
}

function validCloneUrl(value: string) {
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return ['https:', 'ssh:', 'git:'].includes(url.protocol) && !!url.hostname && !url.password && (url.protocol === 'ssh:' || !url.username);
  } catch { return false; }
}

const stageInput = z.object({
  paths: z.array(z.string().min(1)).min(1).describe('Workspace-relative paths to stage.'),
  all: z.boolean().default(false).describe('Stage all changes (git add -A).'),
});

const commitInput = z.object({
  message: z.string().min(1).describe('Commit message.'),
  all: z.boolean().default(false).describe('Stage all tracked modifications before committing.'),
});

const branchManageInput = z.object({
  action: z.enum(['create', 'delete', 'rename', 'checkout']).describe('Branch action to perform.'),
  name: z.string().min(1).describe('Branch name (the branch to delete/checkout, or the new name for create/rename).'),
  newName: z.string().optional().describe('New branch name for rename.'),
  startPoint: z.string().optional().describe('Start point (commit/branch) for create.'),
});

const rebaseInput = z.object({
  onto: z.string().min(1).describe('Explicit target to rebase onto (required; history-rewriting, runs only on explicit request).'),
});

const resetInput = z.object({
  target: z.string().min(1).describe('Explicit commit/branch to reset to.'),
  mode: z.enum(['soft', 'mixed', 'hard']).describe('Reset mode; hard discards working-tree changes.'),
});

export const gitTools: ToolSet = {
  gitStatus: tool({
    description: 'Compact git status of the workspace repository: current branch, upstream ahead/behind, staged/unstaged/untracked files. Prefer this over running git status via shell.',
    contextSchema: hazeToolContextSchema,
    inputSchema: statusInput,
    execute: async (input, context) => runDedupedTool('gitStatus', input, context, async () => {
      try {
        const root = await resolveRepoRoot();
        const confined = input.path ? confinePath(root, input.path) : undefined;
        const run = await runGit(root, ['status', '--porcelain=v1', '-b', ...(confined ? ['--', confined] : [])], context.abortSignal);
        if (run.aborted) return abortedResult('gitStatus');
        if (run.code !== 0) return gitError('gitStatus', run, 'Check that the repository is healthy, then retry.');
        const lines = run.stdout.split('\n').filter(line => line.length > 0);
        const header = lines.find(line => line.startsWith('## ')) ?? '';
        const branch = header.replace(/^## /, '').split('...')[0] || '(detached)';
        const aheadBehind = /\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/.exec(header);
        const staged: string[] = [];
        const unstaged: string[] = [];
        const untracked: string[] = [];
        for (const line of lines) {
          if (line.startsWith('## ')) continue;
          const x = line[0] ?? ' ';
          const y = line[1] ?? ' ';
          const file = line.slice(3);
          if (x === '?' && y === '?') untracked.push(file);
          else {
            if (x !== ' ' && x !== '?') staged.push(file);
            if (y !== ' ' && y !== '?') unstaged.push(file);
          }
        }
        return {
          ok: true, toolName: 'gitStatus', branch, cwd: root,
          ...(aheadBehind ? {ahead: Number(aheadBehind[1] ?? 0), behind: Number(aheadBehind[2] ?? aheadBehind[3] ?? 0)} : {}),
          staged, unstaged, untracked,
        };
      } catch (error) {
        return gitFailure('gitStatus', error, 'Retry gitStatus, or inspect the repository with shell git if the tools do not cover the case.');
      }
    }),
  }),

  gitLog: tool({
    description: `Recent commit history of the workspace repository as compact entries (hash, subject, author, relative time), bounded to ${GIT_LOG_DEFAULT_LIMIT} commits by default. Prefer this over running git log via shell.`,
    contextSchema: hazeToolContextSchema,
    inputSchema: logInput,
    execute: async (input, context) => runDedupedTool('gitLog', input, context, async () => {
      try {
        const root = await resolveRepoRoot();
        const confined = input.path ? confinePath(root, input.path) : undefined;
        const limit = input.limit ?? GIT_LOG_DEFAULT_LIMIT;
        const args = ['log', `--max-count=${limit}`, '--format=%h%x00%s%x00%an%x00%ar', ...(input.range ? [input.range] : []), ...(confined ? ['--', confined] : [])];
        const run = await runGit(root, args, context.abortSignal);
        if (run.aborted) return abortedResult('gitLog');
        if (run.code !== 0) return gitError('gitLog', run, 'Check the range/path, then retry.');
        const commits = run.stdout.split('\n').filter(line => line.includes('\x00')).map(line => {
          const [hash, subject, author, relativeTime] = line.split('\x00');
          return {hash, subject, author, relativeTime};
        });
        return {ok: true, toolName: 'gitLog', count: commits.length, truncated: commits.length >= limit, commits};
      } catch (error) {
        return gitFailure('gitLog', error, 'Retry gitLog with a narrower range or path.');
      }
    }),
  }),

  gitDiff: tool({
    description: `Bounded diff of workspace changes (per-file stats plus patch, default ${GIT_DIFF_DEFAULT_LINES} lines) with a truncation indicator. Prefer this over running git diff via shell.`,
    contextSchema: hazeToolContextSchema,
    inputSchema: diffInput,
    execute: async (input, context) => runDedupedTool('gitDiff', input, context, async () => {
      try {
        const root = await resolveRepoRoot();
        const confined = input.path ? confinePath(root, input.path) : undefined;
        const staged = input.staged ?? false;
        const statRun = await runGit(root, ['diff', '--stat', ...(staged ? ['--staged'] : []), ...(input.range ? [input.range] : []), ...(confined ? ['--', confined] : [])], context.abortSignal);
        if (statRun.aborted) return abortedResult('gitDiff');
        if (statRun.code !== 0) return gitError('gitDiff', statRun, 'Check the range/path, then retry.');
        const patchRun = await runGit(root, ['diff', ...(staged ? ['--staged'] : []), ...(input.range ? [input.range] : []), ...(confined ? ['--', confined] : [])], context.abortSignal);
        if (patchRun.aborted) return abortedResult('gitDiff');
        if (patchRun.code !== 0) return gitError('gitDiff', patchRun, 'Check the range/path, then retry.');
        const limit = input.limit ?? GIT_DIFF_DEFAULT_LINES;
        const patchLines = patchRun.stdout.split('\n');
        const truncated = patchLines.length > limit;
        const patch = truncated ? patchLines.slice(0, limit).join('\n') : patchRun.stdout;
        const files = statRun.stdout.split('\n').filter(line => line.includes('|')).map(line => {
          const [file, stats] = line.split('|');
          return {path: file.trim(), stats: (stats ?? '').trim()};
        });
        return {
          ok: true, toolName: 'gitDiff', files, patch, truncated,
          ...(truncated ? {hint: `Diff truncated at ${limit} lines; narrow with path/range or raise limit (max ${GIT_DIFF_MAX_LINES}).`} : {}),
        };
      } catch (error) {
        return gitFailure('gitDiff', error, 'Retry gitDiff with a narrower path or range.');
      }
    }),
  }),

  gitBranch: tool({
    description: 'List branches of the workspace repository (current, local, optionally remotes). Prefer this over running git branch via shell.',
    contextSchema: hazeToolContextSchema,
    inputSchema: branchInput,
    execute: async (input, context) => runDedupedTool('gitBranch', input, context, async () => {
      try {
        const root = await resolveRepoRoot();
        const wantRemotes = input.remotes ?? false;
        const run = await runGit(root, ['branch', ...(wantRemotes ? ['-a'] : [])], context.abortSignal);
        if (run.aborted) return abortedResult('gitBranch');
        if (run.code !== 0) return gitError('gitBranch', run, 'Retry gitBranch.');
        const current: string[] = [];
        const local: string[] = [];
        const remotes: string[] = [];
        for (const raw of run.stdout.split('\n')) {
          const line = raw.trimEnd();
          if (!line) continue;
          if (line.startsWith('* ')) current.push(line.slice(2).trim());
          else if (line.startsWith('remotes/')) remotes.push(line.replace(/^remotes\//, ''));
          else local.push(line.trim());
        }
        return {ok: true, toolName: 'gitBranch', current, local, ...(wantRemotes ? {remotes} : {})};
      } catch (error) {
        return gitFailure('gitBranch', error, 'Retry gitBranch.');
      }
    }),
  }),

  gitFetch: tool({
    description: 'Fetch updates from a configured Git remote without interactive authentication. Updates remote-tracking refs; does not integrate changes.',
    contextSchema: hazeToolContextSchema,
    inputSchema: remoteInput,
    execute: async (input, context) => runDedupedTool('gitFetch', input, context, async () => {
      try {
        const root = await resolveRepoRoot();
        const run = await runNetworkGit(root, ['fetch', '--no-recurse-submodules', ...(input.remote ? ['--', input.remote] : [])], context.abortSignal);
        if (run.aborted) return abortedResult('gitFetch');
        if (run.code !== 0) return networkFailure('gitFetch', run.timedOut);
        return {ok: true, toolName: 'gitFetch', summary: 'Fetched remote updates.'};
      } catch (error) { return gitFailure('gitFetch', error, 'Check the repository and remote, then retry.'); }
    }),
  }),

  gitPull: tool({
    description: 'Fetch and integrate remote changes into the current branch. Defaults to fast-forward only; use rebase or merge only when requested.',
    contextSchema: hazeToolContextSchema,
    inputSchema: pullInput,
    execute: async (input, context) => runDedupedTool('gitPull', input, context, async () => {
      try {
        const root = await resolveRepoRoot();
        const mode = input.mode ?? 'ff-only';
        const flag = mode === 'merge' ? '--no-rebase' : mode === 'rebase' ? '--rebase' : '--ff-only';
        const run = await runNetworkGit(root, ['pull', flag, '--no-recurse-submodules', ...(input.remote ? ['--', input.remote] : [])], context.abortSignal);
        if (run.aborted) return abortedResult('gitPull');
        if (run.code !== 0) {
          const reason = classifyPullFailure(`${run.stdout.text}\n${run.stderr.text}`);
          return {...networkFailure('gitPull', run.timedOut), ...(reason && !run.timedOut ? {error: reason} : {}), suggestedNextStep: 'Inspect repository status and upstream; resolve any conflicts or choose an appropriate integration policy before retrying.'};
        }
        return {ok: true, toolName: 'gitPull', summary: `Pulled using ${mode}.`};
      } catch (error) { return gitFailure('gitPull', error, 'Check the repository and upstream, then retry.'); }
    }),
  }),

  gitClone: tool({
    description: 'Clone a remote repository into a new workspace-relative directory so its code can be inspected. Authentication is non-interactive.',
    contextSchema: hazeToolContextSchema,
    inputSchema: cloneInput,
    execute: async (input, context) => runDedupedTool('gitClone', input, context, async () => {
      try {
        if (!validCloneUrl(input.url)) throw new HazeToolError('Use an HTTPS, SSH, or git:// repository URL without embedded credentials.', 'git_error', {recoverable: false});
        const target = await prepareWorkspaceWritePath('gitClone', input.path, false, context);
        if (target.scopedStop) return target.scopedStop;
        await target.assertWritableInsideWorkspace();
        try { await fs.lstat(target.absolutePath); return {ok: false as const, toolName: 'gitClone', error: 'Destination already exists.', reasonCode: 'git_error' as const, recoverable: true, suggestedNextStep: 'Choose a new destination.'}; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const run = await runNetworkGit(workspaceRoot(), ['clone', '--no-recurse-submodules', '--', input.url, target.absolutePath], context.abortSignal);
        if (run.aborted) return abortedResult('gitClone');
        if (run.code !== 0) return networkFailure('gitClone', run.timedOut);
        return {ok: true, toolName: 'gitClone', path: input.path, summary: `Cloned into ${input.path}.`};
      } catch (error) { return gitFailure('gitClone', error, 'Check the destination and repository URL, then retry.'); }
    }),
  }),

  gitStage: tool({
    description: 'Stage workspace files (git add). Mutating git operation on the workspace repository.',
    contextSchema: hazeToolContextSchema,
    inputSchema: stageInput,
    execute: async (input, context) => runDedupedTool('gitStage', input, context, async () => {
      try {
        const root = await resolveRepoRoot();
        const confined = input.paths.map(p => confinePath(root, p));
        const run = await runGit(root, (input.all ?? false) ? ['add', '-A'] : ['add', '--', ...confined], context.abortSignal);
        if (run.aborted) return abortedResult('gitStage');
        if (run.code !== 0) return gitError('gitStage', run, 'Check the paths, then retry.');
        return {ok: true, toolName: 'gitStage', summary: (input.all ?? false) ? 'Staged all changes.' : `Staged: ${confined.join(', ')}`};
      } catch (error) {
        return gitFailure('gitStage', error, 'Retry gitStage with valid workspace-relative paths.');
      }
    }),
  }),

  gitCommit: tool({
    description: 'Create a commit in the workspace repository (git commit). Mutating git operation.',
    contextSchema: hazeToolContextSchema,
    inputSchema: commitInput,
    execute: async (input, context) => runDedupedTool('gitCommit', input, context, async () => {
      try {
        const root = await resolveRepoRoot();
        const run = await runGit(root, ['commit', ...((input.all ?? false) ? ['-a'] : []), '-m', input.message], context.abortSignal);
        if (run.aborted) return abortedResult('gitCommit');
        if (run.code !== 0) return gitError('gitCommit', run, 'Stage changes first (gitStage), resolve conflicts, then retry.');
        return {ok: true, toolName: 'gitCommit', summary: run.stdout.split('\n')[0] ?? 'committed'};
      } catch (error) {
        return gitFailure('gitCommit', error, 'Stage changes with gitStage, then retry gitCommit.');
      }
    }),
  }),

  gitBranchManage: tool({
    description: 'Create, rename, checkout, or delete a branch in the workspace repository. Mutating git operation.',
    contextSchema: hazeToolContextSchema,
    inputSchema: branchManageInput,
    execute: async (input, context) => runDedupedTool('gitBranchManage', input, context, async () => {
      try {
        const root = await resolveRepoRoot();
        const args = (() => {
          switch (input.action) {
            case 'create': return ['branch', input.name, ...(input.startPoint ? [input.startPoint] : [])];
            case 'delete': return ['branch', '-d', input.name];
            case 'rename': return ['branch', '-m', input.name, ...(input.newName ? [input.newName] : [])];
            case 'checkout': return ['checkout', input.name];
          }
        })();
        const run = await runGit(root, args, context.abortSignal);
        if (run.aborted) return abortedResult('gitBranchManage');
        if (run.code !== 0) return gitError('gitBranchManage', run, 'Check the branch name/action, then retry.');
        return {ok: true, toolName: 'gitBranchManage', summary: `${input.action} ${input.name}${input.newName ? ` -> ${input.newName}` : ''}`};
      } catch (error) {
        return gitFailure('gitBranchManage', error, 'Retry gitBranchManage with a valid action and branch name.');
      }
    }),
  }),

  gitRebase: tool({
    description: 'Rebase the current branch onto an explicit target (git rebase). History-rewriting: runs only when explicitly requested.',
    contextSchema: hazeToolContextSchema,
    inputSchema: rebaseInput,
    execute: async (input, context) => runDedupedTool('gitRebase', input, context, async () => {
      try {
        const root = await resolveRepoRoot();
        const run = await runGit(root, ['rebase', input.onto], context.abortSignal);
        if (run.aborted) return abortedResult('gitRebase');
        if (run.code !== 0) return gitError('gitRebase', run, 'Resolve conflicts or abort the rebase via shell, then retry.');
        return {ok: true, toolName: 'gitRebase', summary: `Rebased onto ${input.onto}.`};
      } catch (error) {
        return gitFailure('gitRebase', error, 'Retry gitRebase with a valid target.');
      }
    }),
  }),

  gitReset: tool({
    description: 'Reset the current branch to an explicit target with an explicit mode (git reset). History/working-tree rewriting (hard): runs only when explicitly requested.',
    contextSchema: hazeToolContextSchema,
    inputSchema: resetInput,
    execute: async (input, context) => runDedupedTool('gitReset', input, context, async () => {
      try {
        const root = await resolveRepoRoot();
        const run = await runGit(root, ['reset', `--${input.mode}`, input.target], context.abortSignal);
        if (run.aborted) return abortedResult('gitReset');
        if (run.code !== 0) return gitError('gitReset', run, 'Check the target, then retry.');
        return {ok: true, toolName: 'gitReset', summary: `Reset --${input.mode} to ${input.target}.`};
      } catch (error) {
        return gitFailure('gitReset', error, 'Retry gitReset with a valid target and mode.');
      }
    }),
  }),
};
