# Contracts: OS-Level Sandboxing (seatbelt / bubblewrap)

**Feature Branch**: `os-sandbox` · Exact types, schemas, and generated-artifact templates referenced by `plan.md`. TypeScript snippets follow repo conventions (strict, ESM, `.js` import extensions at use sites, no `any`, Zod for schemas).

---

## 1. Settings schema (`src/config/settings.ts`)

```ts
export interface HazeSandboxSettings {
  /**
   * 'auto' (default): sandbox when a backend is available; degrade visibly when not.
   * 'on': require a backend — model commands fail fast with 'sandbox_unavailable' when absent.
   * 'off': never sandbox.
   */
  mode?: 'auto' | 'on' | 'off';
  /** 'workspace' (default): network allowed, caches writable. 'strict': network denied, caches read-only. */
  profile?: 'workspace' | 'strict';
  /** Extra user-granted read-only roots. `~`-expanded at use time. Protected-secret paths are rejected loudly. */
  roRoots?: string[];
  /** Extra user-granted read-write roots. Same validation as roRoots. */
  rwRoots?: string[];
}
```

Zod (inside the settings schema tree, `.passthrough()` behavior preserved):

```ts
const sandboxSchema = z.object({
  mode: z.enum(['auto', 'on', 'off']).optional(),
  profile: z.enum(['workspace', 'strict']).optional(),
  roRoots: z.array(z.string().min(1)).optional(),
  rwRoots: z.array(z.string().min(1)).optional(),
}).strict().optional();
```

Validation additions:

- Roots must not resolve to protected secret paths (`isProtectedSecretPath`, lexical check at load; runtime realpath backstop in `boundary.ts`). Violations fail loudly with the settings file path and the offending root (existing error style).
- Unknown fields elsewhere in settings remain preserved (existing patch contract).

## 2. Core types (`src/core/sandbox/boundary.ts`)

```ts
export type SandboxBackend = 'seatbelt' | 'bubblewrap' | 'none';
export type SandboxProfileName = 'workspace' | 'strict';
export type SandboxAccess = 'rw' | 'ro';

export interface SandboxRoot {
  /** Canonical path (realpath'd when it exists; lexical fallback otherwise). */
  path: string;
  access: SandboxAccess;
  /** Provenance for /sandbox display and diagnostics. */
  origin: 'workspace' | 'system' | 'config' | 'blessed' | 'settings' | 'temp' | 'cache' | 'runtime';
}

export interface SandboxMask {
  /** Path made unreadable/empty inside the sandbox (config-dir credentials, transcripts). */
  path: string;
  reason: string; // e.g. 'provider API keys', 'session transcripts'
}

export interface SandboxBoundary {
  workspaceRoot: string;
  profile: SandboxProfileName;
  roots: readonly SandboxRoot[];      // deduped; rw absorbs covered ro
  masks: readonly SandboxMask[];      // only meaningful inside mounted config dirs
  network: 'allow' | 'deny';
  backendHint: SandboxBackend;        // expected backend for this platform
  runtime: {                          // frozen facts used to build it (seam for tests)
    platform: NodeJS.Platform;
    homedir: string;
    tmpdir: string;
    shellPath: string;
    nodeExecDir: string;
  };
}

export interface SandboxBackendInfo {
  backend: SandboxBackend;
  /** Why a backend is unavailable ('unsupported_platform' | 'missing_binary' | 'userns_denied' | 'probe_failed'). */
  reason?: string;
  detail?: string; // bounded stderr excerpt for doctor display
}

export function buildSandboxBoundary(input: {
  workspaceRoot: string;
  blessedPaths: readonly {realPath: string; isDirectory: boolean}[];
  settings: {sandbox?: HazeSandboxSettings};
  runtime: SandboxBoundary['runtime'];
}): Promise<SandboxBoundary>;
```

Invariants (tested):

1. Workspace root is always `rw`.
2. Blessed paths are always `ro` (even if the user also listed them in `rwRoots`, the blessing alone never grants write; an explicit `rwRoots` entry is a *separate* user action and does grant `rw`).
3. No root is/contains a protected secret path unless it is a config dir whose secrets are all masked.
4. `roots` is deduped: a root covered by an `rw` ancestor is dropped; an `ro` root covered by another `ro` ancestor is dropped.
5. Deterministic ordering: by `origin` weight (workspace, temp, cache, config, runtime, system, blessed, settings) then lexicographic — snapshots depend on it.

## 3. Seatbelt artifacts (`src/core/sandbox/seatbelt.ts`)

```ts
export function seatbeltProfile(boundary: SandboxBoundary): string;
export function seatbeltInvocation(target: {command: string; args: string[]}, boundary: SandboxBoundary): {command: 'sandbox-exec'; args: string[]};
```

Template (ordering is contractual; denies last):

```scheme
(version 1)
(import "system.sb")
(deny default)
(allow file-read* (subpath "/bin") (subpath "/sbin") (subpath "/usr/bin") … )  ; one allow per root group
(allow file-read-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))
(allow file-write* (subpath "<workspace>") (subpath "<tmpdir>") (subpath "<caches>") …)
(allow process-exec (literal "<shellPath>"))
(allow process-exec (subpath "/bin") (subpath "/usr/bin") (subpath "/usr/local/bin") (subpath "/opt/homebrew/bin") (subpath "<nodeExecDir>") …)
(allow process-fork)
(allow sysctl-read)
(allow network*)            ; workspace profile
;; strict profile replaces the line above with:
;; (deny network*)
(deny file-read* (literal "<mask1>") (subpath "<maskDir1>") …)   ; credential masks, LAST
(deny file-write* (literal "/dev/kmem") (literal "/dev/mem"))
```

Invocation:

```
sandbox-exec -p '<profile>' -- <shellPath> [-l] -c <command>
```

Rules:

- The profile is one argv entry; never written to a file.
- Paths are inserted with Scheme string escaping (backslash/quote) — implement an `sbplString()` helper and test it.
- Compile errors from `sandbox-exec` (malformed profile) must be surfaced as configuration failures (`sandbox_profile_error`), not as command output.

## 4. Bubblewrap artifacts (`src/core/sandbox/bubblewrap.ts`)

```ts
export function bubblewrapArgs(boundary: SandboxBoundary, runtime: {uid: number; gid: number}): string[];
export function bubblewrapInvocation(target: {command: string; args: string[]}, boundary: SandboxBoundary, runtime: {uid: number; gid: number}): {command: 'bwrap'; args: string[]};
```

Canonical argv order (contractual; snapshot-pinned):

```
--unshare-user --uid <uid> --gid <gid>
--unshare-ipc --unshare-uts
--die-with-parent
[--unshare-net]                                  # strict profile only
--ro-bind /usr /usr
--ro-bind-try /bin /bin --ro-bind-try /sbin /sbin
--ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64
--ro-bind-try /etc /etc --ro-bind-try /opt /opt
--proc /proc
--dev /dev
--tmpfs /dev/shm
--tmpfs /tmp | --bind <TMPDIR> <TMPDIR>          # private TMPDIR outside /tmp
--tmpfs <HOME>
--ro-bind <HOME>/.haze <HOME>/.haze              # config dirs AFTER the tmpfs
--ro-bind /dev/null <HOME>/.haze/settings.json   # masks AFTER their owning dir bind
--ro-bind <HOME>/.claude <HOME>/.claude
--ro-bind-try <HOME>/.gitconfig <HOME>/.gitconfig
--ro-bind-try <nodeExecDir> <nodeExecDir>        # toolchains under $HOME
--ro-bind <blessed> <blessed>                    # per blessed root
--ro-bind <settingsRoRoot> <settingsRoRoot>
--bind <workspace> <workspace>
--bind <cache> <cache>                           # per rw root (incl. caches)
--chdir <workspace>
-- <shellPath> [-l] -c <command>
```

Rules:

- Every optional host path uses `-try` variants so missing paths never fail the sandbox itself.
- No `--unshare-pid` in v1 (see `plan.md` §7.2).
- `HOME` must be set in the child env (it is inherited) for the tmpfs home to be honored by tools.

## 5. Detection (`src/core/sandbox/detect.ts`)

```ts
export function detectSandboxBackend(options?: {probeTimeoutMs?: number}): Promise<SandboxBackendInfo>;
export function resetSandboxDetection(): void; // test seam
```

- Probes use direct `spawn` (no shell), `stdio: 'ignore'` + captured stderr, short deadline, and are killed on timeout.
- Classification: exit 0 → backend available; ENOENT binary → `missing_binary`; bwrap EPERM/EACCES mentioning `user namespace`/`apparmor` → `userns_denied`; anything else → `probe_failed` with bounded stderr excerpt.

## 6. Composition & metadata (`src/core/sandbox/runner.ts`)

```ts
export interface ShellSandboxMetadata {
  enabled: boolean;
  backend: SandboxBackend;
  profile: SandboxProfileName;
  /** Present when enabled=false: why (mode off / backend unavailable+reason). */
  reason?: string;
}

export function wrapInvocation(
  target: {command: string; args: string[]},
  boundary: SandboxBoundary | undefined,   // undefined ⇒ tool context had none
  backendInfo: SandboxBackendInfo | undefined,
  mode: ResolvedSandboxMode,
): {invocation: {command: string; args: string[]}; sandbox: ShellSandboxMetadata};

export type ResolvedSandboxMode = {enabled: true; profile: SandboxProfileName} | {enabled: false; reason: 'mode_off' | 'no_backend'; detail?: string};
export function resolveSandboxMode(input: {cliOverride?: string; sessionOverride?: PromptSession['sandboxOverride']; settings?: HazeSandboxSettings; backendInfo: SandboxBackendInfo}): ResolvedSandboxMode;
```

Precedence (mirrors `--reasoning`): CLI `--sandbox` → `/sandbox` session override (`PromptSession.sandboxOverride`, in-memory only) → settings → built-in default `auto` + `workspace`.

## 7. Tool context & shell result shapes

`HazeToolContext` (in `src/llm/tools/toolContextState.ts`) gains:

```ts
/** Immutable per-attempt OS sandbox state for child processes (see src/core/sandbox/AGENTS.md). */
sandboxRuntime?: SandboxRuntimeState; // {resolved: ResolvedSandboxMode; boundary?: SandboxBoundary; remedy?: string}
```

(Implementation note: shipped as a single `sandboxRuntime` state object rather than a bare boundary, so tools can also report truthful `enabled: false` reasons.)

(`isHazeToolContext` gains the corresponding optional guard arm.)

Shell tool result (both ok and failed results; protocol-safe, bounded):

```ts
sandbox?: {
  enabled: boolean;
  backend: 'seatbelt' | 'bubblewrap' | 'none';
  profile: 'workspace' | 'strict';
  reason?: string;                       // when enabled=false
  denial?: {kind: 'read' | 'write' | 'exec' | 'network' | 'unknown'; pathHint?: string};
};
```

Failure augmentation (via `diagnostics.ts`): when a sandbox denial is classified, merge:

```ts
{reasonCode: 'sandbox_boundary', recoverable: true,
 suggestedNextStep: 'Path is outside the sandbox boundary. Ask the user to @mention the path in the prompt (grants a read), extend sandbox.roRoots/rwRoots in ~/.haze/settings.json, or run /sandbox off.'}
```

And when `mode: 'on'` but no backend:

```ts
{reasonCode: 'sandbox_unavailable', recoverable: false,
 suggestedNextStep: '<platform-specific remedy: install bubblewrap / enable user namespaces / sandbox-exec missing>'}
```

Precedence with existing diagnostics: `missing_executable` keeps priority; sandbox metadata always rides along.

## 8. Diagnostics (`src/core/sandbox/diagnostics.ts`)

```ts
export interface SandboxDenial {kind: 'read' | 'write' | 'exec' | 'network' | 'unknown'; pathHint?: string}
export function classifySandboxDenial(input: {code: number | null; stderr: string; boundary: SandboxBoundary}): SandboxDenial | undefined;
```

- Input `stderr` is the already-retained, byte-bounded text (never re-reads raw output).
- Must return `undefined` for unrelated failures; tests pin true-positive and true-negative sets per backend errno class (EPERM/EACCES/EROFS → read/write/exec; ENOENT only when the mentioned path exists on the host outside the boundary).

## 9. `/sandbox` command surface

```
/sandbox                 status: backend (+probe reason), mode + source chain (flag > session > settings > default),
                         profile, rw/ro roots (tilde-shortened, origin-tagged), mask count
/sandbox auto|on|off     session-scoped mode override (PromptSession in-memory; never persisted)
/sandbox workspace|strict  session-scoped profile override
/sandbox test            runs: (1) touch inside workspace  (2) read outside boundary  (3) read ~/.haze/AGENTS.md
                         prints pass/fail per probe with the boundary in effect
```

System message on degraded `auto` (once per session): `Sandboxing unavailable: <reason>. Commands run unsandboxed. See /sandbox.`

## 10. Test fixture contracts

- Pure generators accept fake `runtime` facts → cross-platform snapshots run everywhere.
- `detect.ts` accepts an injected spawn seam in tests (`options.spawnProcess`, same pattern as `signalProcessTree`).
- E2E gating: `HAZE_SANDBOX_E2E=1` env (CI opt-in) **and** a live probe success; otherwise `describe.skip` with the reason printed once.
- No test ever prints real credential contents; mask tests assert emptiness/denial only.
