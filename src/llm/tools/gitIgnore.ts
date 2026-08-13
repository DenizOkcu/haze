import {spawn} from 'node:child_process';
import {workspaceRelativePath, workspaceRoot} from '../../utils/path.js';

/**
 * Maximum candidate paths submitted to a single `git check-ignore` invocation.
 * Bounding the batch keeps stdin/stdout bounded while collapsing hundreds of
 * entries into O(batches) subprocesses instead of one process per path
 * (RH-001). 256 candidates comfortably fits a typical directory frontier.
 */
export const GIT_IGNORE_BATCH = 256;

/**
 * Generous stdout ceiling for a single batch. check-ignore echoes at most the
 * ignored paths it was given, so this is bounded by batch size in practice.
 */
const CHECK_IGNORE_MAX_BYTES = 8 * 1024 * 1024;

export interface IgnoreClassifier {
  /**
   * Classify workspace-relative candidate paths. Returns the subset that Git
   * reports as ignored. Fails open: a non-repository, an operational Git
   * failure, and the "no paths ignored" exit code (1) all resolve to "nothing
   * here is ignored" so workspace reads are never blocked by ignore checks.
   */
  classify(relativePaths: readonly string[]): Promise<Set<string>>;
  /** Number of `git check-ignore` subprocesses started by this classifier. */
  readonly invocationCount: number;
}

/**
 * Run one bounded `git check-ignore -z --stdin` invocation. Resolves with the
 * raw NUL-delimited stdout (empty when no paths are ignored or the workspace is
 * not a repository); rejects only on a spawn-level failure such as git missing.
 */
function runCheckIgnore(root: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, 'check-ignore', '-z', '--stdin'], {windowsHide: true});
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let overflowed = false;
    let settled = false;

    const finish = (stdout: string) => {
      if (settled) return;
      settled = true;
      resolve(stdout);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (overflowed) return;
      totalBytes += chunk.length;
      if (totalBytes > CHECK_IGNORE_MAX_BYTES) {
        overflowed = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', () => undefined);
    child.on('error', fail);
    child.on('close', () => {
      // Exit codes: 0 = some ignored, 1 = none ignored, 128 = not a repo. All
      // are resolved with whatever stdout arrived (empty for 1/128); overflow
      // yields empty output so the batch fails open (nothing reported ignored).
      finish(overflowed ? '' : Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input, 'utf8');
  });
}

/**
 * Create a bounded batch ignore classifier rooted at `root` (defaults to the
 * workspace root). One classifier should own an entire listing operation so
 * sibling/frontier candidates share subprocesses.
 */
export function createIgnoreClassifier(root: string = workspaceRoot()): IgnoreClassifier {
  let invocationCount = 0;
  const classify = async (relativePaths: readonly string[]): Promise<Set<string>> => {
    // De-duplicate and drop meaningless inputs; preserve insertion uniqueness
    // so the returned set keys match caller-supplied relative paths exactly.
    const unique = Array.from(new Set(relativePaths.filter(candidate => candidate && candidate !== '.')));
    if (unique.length === 0) return new Set();
    const ignored = new Set<string>();
    for (let offset = 0; offset < unique.length; offset += GIT_IGNORE_BATCH) {
      const batch = unique.slice(offset, offset + GIT_IGNORE_BATCH);
      const input = `${batch.join('\0')}\0`;
      invocationCount++;
      // check-ignore echoes each ignored path verbatim (NUL-delimited with
      // -z). Matching by exact submitted string preserves spaces, embedded
      // newlines, and unusual names; only ignored entries appear in stdout.
      try {
        const stdout = await runCheckIgnore(root, input);
        for (const part of stdout.split('\0')) if (part) ignored.add(part);
      } catch {
        // Spawn-level failure (e.g. git not installed): fail open with
        // whatever has been classified so far; remaining paths are not ignored.
        return ignored;
      }
    }
    return ignored;
  };
  return {
    classify,
    get invocationCount() {
      return invocationCount;
    },
  };
}

/** Classify a set of workspace-relative paths in bounded batches. */
export async function classifyGitIgnored(relativePaths: readonly string[], root?: string): Promise<Set<string>> {
  return createIgnoreClassifier(root ?? workspaceRoot()).classify(relativePaths);
}

/**
 * Single-path ignore classification (used by mutating-tool guards and other
 * one-off checks). Built on the batch primitive so the public fail-open
 * contract is identical to batched traversal.
 */
export async function isGitIgnored(absolutePath: string): Promise<boolean> {
  const relative = workspaceRelativePath(absolutePath);
  if (relative === '.') return false;
  const ignored = await classifyGitIgnored([relative], workspaceRoot());
  return ignored.has(relative);
}
