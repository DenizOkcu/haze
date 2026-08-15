import {existsSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compareVersions} from './version.js';

/** Package identity used to recognize a haze checkout near the working directory. */
export const HAZE_PACKAGE_NAME = '@denizokcu/haze';

/**
 * Build provenance embedded by `npm run build` (dist/buildInfo.json). Safe
 * metadata only — never environment, credentials, or conversation content.
 */
export interface BuildInfo {
  name: string;
  version: string;
  commit?: string;
  builtAt?: string;
  sourceRoot?: string;
}

/**
 * Runtime capability registry: observable facts about the running build, so
 * behavior can be diagnosed without inferring it from semantic versions.
 * All three land together with the goal supervisor; a runtime missing its
 * compiled artifact reports every supervisor capability as unavailable.
 */
export interface RuntimeCapabilities {
  logicalGoalSupervisor: boolean;
  crossTurnCheckpoints: boolean;
  automaticBudgetContinuation: boolean;
}

/** Compiled module whose presence proves the autonomous goal supervisor is in this build. */
export const GOAL_SUPERVISOR_ARTIFACT = join('dist', 'cli', 'commands', 'streaming', 'goalSupervisor.js');

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a buildInfo.json payload defensively; malformed files read as absent. */
export function parseBuildInfo(value: unknown): BuildInfo | undefined {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.version !== 'string') return undefined;
  const info: BuildInfo = {name: value.name, version: value.version};
  if (typeof value.commit === 'string' && value.commit) info.commit = value.commit;
  if (typeof value.builtAt === 'string' && value.builtAt) info.builtAt = value.builtAt;
  if (typeof value.sourceRoot === 'string' && value.sourceRoot) info.sourceRoot = value.sourceRoot;
  return info;
}

/** Default candidate locations: dist/utils/../buildInfo.json (built) and <repo>/dist (running from src via tsx). */
function defaultBuildInfoCandidates(): string[] {
  return [
    join(MODULE_DIR, '..', 'buildInfo.json'),
    join(MODULE_DIR, '..', '..', 'dist', 'buildInfo.json'),
  ];
}

let cachedBuildInfo: BuildInfo | undefined | null;

/**
 * Provenance of the running build, or undefined when no buildInfo.json is
 * readable (source runs without a prior build). Cached per process; explicit
 * candidate paths bypass the cache (tests, doctor probing another root).
 */
export function readBuildInfo(candidates?: readonly string[]): BuildInfo | undefined {
  if (!candidates) {
    if (cachedBuildInfo !== null) return cachedBuildInfo ?? undefined;
    const found = loadBuildInfoFrom(defaultBuildInfoCandidates());
    cachedBuildInfo = found ?? null;
    return found ?? undefined;
  }
  return loadBuildInfoFrom(candidates);
}

/** Read the first parsable buildInfo.json among the candidate paths. */
export function loadBuildInfoFrom(candidates: readonly string[]): BuildInfo | undefined {
  for (const candidate of candidates) {
    try {
      return parseBuildInfo(JSON.parse(readFileSync(candidate, 'utf8')));
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/** Read a package.json version from an explicit package root. */
export function readPackageVersionAt(root: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {version?: unknown};
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** Read a package.json name from an explicit package root. */
export function readPackageNameAt(root: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {name?: unknown};
    return typeof parsed.name === 'string' ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Nearest ancestor directory (starting at `start`, default: this module's
 * location) containing a package.json — i.e. the package root of the code
 * that is actually executing.
 */
export function resolvePackageRoot(start: string = MODULE_DIR): string | undefined {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolve the current git HEAD commit without spawning git: reads .git/HEAD
 * (detached sha or symbolic ref), then the ref file or packed-refs. Returns
 * undefined whenever the commit cannot be determined without guessing.
 */
export function gitHeadCommit(root: string): string | undefined {
  const sha = (value: string | undefined) => (/^[0-9a-f]{7,40}$/i.test((value ?? '').trim()) ? value!.trim() : undefined);
  try {
    const dotGitPath = join(root, '.git');
    const stat = statSync(dotGitPath);
    const gitDir = stat.isDirectory()
      ? dotGitPath
      : /gitdir:\s*(\S+)/.exec(readFileSync(dotGitPath, 'utf8'))?.[1];
    if (!gitDir) return undefined;
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return sha(head);
    const ref = head.slice(4).trim();
    const refPath = join(gitDir, ref);
    if (existsSync(refPath)) return sha(readFileSync(refPath, 'utf8'));
    const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8');
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return sha(new RegExp(`^([0-9a-f]{40}) ${escaped}$`, 'm').exec(packed)?.[1]);
  } catch {
    return undefined;
  }
}

/** True when the goal-supervisor compiled module exists under this package root. */
export function goalSupervisorArtifactPresent(root: string): boolean {
  try {
    return existsSync(join(root, GOAL_SUPERVISOR_ARTIFACT));
  } catch {
    return false;
  }
}

/** Capabilities of the running build, verified against its compiled artifacts. */
export function runtimeCapabilities(root: string = resolvePackageRoot() ?? process.cwd()): RuntimeCapabilities {
  const supervisor = goalSupervisorArtifactPresent(root);
  return {
    logicalGoalSupervisor: supervisor,
    crossTurnCheckpoints: supervisor,
    automaticBudgetContinuation: supervisor,
  };
}

/** One-line capability summary for logs and doctor output. */
export function formatCapabilities(capabilities: RuntimeCapabilities): string {
  return [
    `logical-goal-supervisor=${capabilities.logicalGoalSupervisor ? 'enabled' : 'disabled'}`,
    `cross-turn-checkpoints=${capabilities.crossTurnCheckpoints ? 'enabled' : 'disabled'}`,
    `automatic-budget-continuation=${capabilities.automaticBudgetContinuation ? 'enabled' : 'disabled'}`,
  ].join(', ');
}

/** Structured description of the executing runtime (used by --version --verbose and doctor). */
export interface RuntimeProvenance {
  version: string;
  build?: BuildInfo;
  /** Package root of the executing code (contains package.json). */
  runtimeRoot?: string;
  /** Resolved entry executable (process.argv[1]); undefined in non-CLI contexts. */
  executable?: string;
  capabilities: RuntimeCapabilities;
}

/** Resolved entry executable (process.argv[1]); undefined in non-CLI contexts. */
export function resolveExecutable(): string | undefined {
  if (!process.argv[1]) return undefined;
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1];
  }
}

export function describeRuntime(input: {runtimeRoot?: string} = {}): RuntimeProvenance {
  const runtimeRoot = input.runtimeRoot ?? resolvePackageRoot();
  const build = readBuildInfo(input.runtimeRoot ? [join(input.runtimeRoot, 'dist', 'buildInfo.json')] : undefined);
  const version = build?.version ?? readPackageVersionAt(runtimeRoot ?? '') ?? '0.0.0';
  return {version, build, runtimeRoot, executable: resolveExecutable(), capabilities: runtimeCapabilities(runtimeRoot ?? process.cwd())};
}

/** `haze --version --verbose` block: version, commit, runtime/executable paths, supervisor state. */
export function formatVersionVerbose(provenance: RuntimeProvenance = describeRuntime()): string {
  const lines = [
    `Haze ${provenance.version}`,
    `commit: ${provenance.build?.commit ?? 'unknown'}`,
    ...(provenance.build?.builtAt ? [`builtAt: ${provenance.build.builtAt}`] : []),
  ];
  if (provenance.runtimeRoot) lines.push(`runtime: ${join(provenance.runtimeRoot, 'dist')}`);
  if (provenance.executable) lines.push(`executable: ${provenance.executable}`);
  lines.push(`goal supervisor: ${provenance.capabilities.logicalGoalSupervisor ? 'enabled' : 'disabled'}`);
  return lines.join('\n');
}

/** A nearby haze checkout whose version/commit diverges from the executing runtime. */
export interface CheckoutMismatch {
  /** Package root of the executing runtime. */
  executingRoot: string;
  executingVersion: string;
  executingCommit?: string;
  /** Package root of the nearby checkout found from the working directory. */
  checkoutRoot: string;
  checkoutVersion: string;
  checkoutCommit?: string;
  /** True when the checkout's version string differs from the executing one. */
  versionDiffers: boolean;
  /** True when the checkout's version is strictly newer than the executing one. */
  checkoutNewer: boolean;
}

function sameRealPath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/**
 * Detect a haze source checkout at/above `cwd` that differs from the executing
 * runtime — the classic failure where a globally installed haze (e.g. 0.10.0)
 * silently serves requests while the checkout beside the workspace already
 * contains the fix. Returns undefined when there is nothing to warn about.
 */
export function detectCheckoutMismatch(input: {executingRoot?: string; cwd?: string} = {}): CheckoutMismatch | undefined {
  const executingRoot = input.executingRoot ?? resolvePackageRoot();
  if (!executingRoot) return undefined;
  let dir = resolve(input.cwd ?? process.cwd());
  let checkoutRoot: string | undefined;
  while (true) {
    if (readPackageNameAt(dir) === HAZE_PACKAGE_NAME) {
      checkoutRoot = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!checkoutRoot || sameRealPath(checkoutRoot, executingRoot)) return undefined;
  const executingVersion = readPackageVersionAt(executingRoot) ?? readBuildInfo([join(executingRoot, 'dist', 'buildInfo.json')])?.version ?? 'unknown';
  const checkoutVersion = readPackageVersionAt(checkoutRoot) ?? 'unknown';
  const executingCommit = readBuildInfo([join(executingRoot, 'dist', 'buildInfo.json')])?.commit ?? gitHeadCommit(executingRoot);
  const checkoutCommit = readBuildInfo([join(checkoutRoot, 'dist', 'buildInfo.json')])?.commit ?? gitHeadCommit(checkoutRoot);
  const versionDiffers = executingVersion !== checkoutVersion;
  const commitDiffers = executingCommit != null && checkoutCommit != null && executingCommit !== checkoutCommit;
  if (!versionDiffers && !commitDiffers) return undefined;
  return {
    executingRoot,
    executingVersion,
    ...(executingCommit ? {executingCommit} : {}),
    checkoutRoot,
    checkoutVersion,
    ...(checkoutCommit ? {checkoutCommit} : {}),
    versionDiffers,
    checkoutNewer: compareVersions(checkoutVersion, executingVersion) > 0,
  };
}

/** Startup warning for a stale runtime executing next to a newer checkout. */
export function formatMismatchWarning(mismatch: CheckoutMismatch): string {
  const head = mismatch.versionDiffers
    ? `Running Haze ${mismatch.executingVersion} from ${mismatch.executingRoot}, but checkout ${mismatch.checkoutRoot} is ${mismatch.checkoutVersion}.`
    : `Running Haze ${mismatch.executingVersion} (commit ${mismatch.executingCommit?.slice(0, 7) ?? '?'}) from ${mismatch.executingRoot}, but checkout ${mismatch.checkoutRoot} is at commit ${mismatch.checkoutCommit?.slice(0, 7) ?? '?'}.`;
  return [
    head,
    mismatch.checkoutNewer || mismatch.versionDiffers ? 'The checkout contains newer runtime behavior than the binary serving this session.' : 'The checkout was rebuilt or moved ahead of the running binary.',
    'Run `npm run dev:link` inside the checkout (rebuild + relink), or start it directly with `npm run haze -- <args>`.',
  ].join('\n');
}
