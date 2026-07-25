# haze 0.8.0 security findings

**Scope:** current `main` worktree on 2026-07-10.  
**Threat model:** the model, repository content, fetched pages, language/MCP server output, and generated skills are untrusted inputs. The user explicitly trusts haze to run relevant shell commands, so unrestricted requested command execution is intentional; this review focuses on promised boundaries, secret handling, availability, and truthful cancellation.

Severity meanings:

- **High:** practical confidentiality, integrity, or availability failure in a documented boundary; fix before the next feature release.
- **Medium:** defense-in-depth or integration trust gap requiring user setup or local preconditions.
- **Low:** hardening with limited direct impact.

## SEC-01 — Private haze data is created with ordinary, often world-readable permissions

**Severity:** High  
**CWE:** CWE-732 (Incorrect Permission Assignment for Critical Resource)  
**Evidence:**

- `src/config/settings.ts:121-127` creates the settings directory and temp JSON file without explicit modes.
- `src/core/session/sessionStore.ts:61-64`, `src/core/log/llmLog.ts:77-86`, and `src/config/inputHistory.ts:27-29` do the same for transcripts, debug tool I/O, and prompt history.
- Settings can contain provider keys and MCP authorization headers.
- Sessions contain prompts and tool results; debug logs contain full tool inputs/outputs.
- On the reviewed machine, `~/.haze/settings.json` and `~/.haze/history/input-history.json` were `0644`; `~/.haze` and `~/.haze/sessions` were `0755`.

**Impact:** Another local account on a multi-user machine can read API keys, prompts, file content captured in sessions, and debug tool I/O when parent-directory traversal permits it. The atomic settings temp file is also exposed during its lifetime.

**Recommendation (DRY/KISS):**

Create one small `src/config/privateStorage.ts` helper and use it for all `~/.haze` state:

- ensure directories with mode `0700`, correcting existing overly broad modes where supported;
- create/replace files with mode `0600`;
- use same-directory temp file + flush/close + rename for settings/history/update state;
- ensure session/log append files are `0600` on first creation;
- avoid changing workspace `.haze/tasks.json` policy unless explicitly desired, because workspace collaboration semantics differ from home-directory secrets.

Do not build a general virtual filesystem abstraction.

**Acceptance tests:**

- New settings, sessions, logs, and history files are `0600` on POSIX; directories are `0700`.
- Rewriting an existing file does not broaden its mode.
- Tests skip exact mode assertions on Windows but still exercise successful writes.
- Existing data remains readable and is tightened opportunistically.

## SEC-02 — Bash output and stored raw output can exhaust process memory

**Severity:** High  
**CWE:** CWE-400 (Uncontrolled Resource Consumption)

**Evidence:**

- `src/llm/tools/bashTool.ts:41-42` concatenates every stdout/stderr chunk into unbounded strings until process close.
- Reduction and `capOutputForProcessing` happen only after the entire process output is resident.
- `src/core/agent/toolOutputStore.ts:14-25` limits entries by count (100), not aggregate bytes or bytes per entry.
- `readFile` (`src/llm/hazeTools.ts:87`) and session/log readers similarly load complete files before applying model-facing limits.

**Impact:** A command such as `yes`, a noisy build, or an accidental binary dump can crash haze or the host Node process before reducers run. Repeated large raw outputs can retain substantial memory for the process lifetime.

**Recommendation:**

- Add a bounded streaming collector shared by bash and future child-process tools.
- Maintain separate head/tail preview buffers and a hard raw byte ceiling.
- If full retrieval is required, spool beyond-memory output to a private temporary file with a bounded total quota; otherwise report that bytes beyond the hard cap were dropped.
- Change `toolOutputStore` to enforce both per-entry and aggregate-byte budgets.
- Stream/paginate `readFile` instead of loading a whole file for a bounded line page. Exact mutation tools may still need a complete file, but should reject files above an explicit safe edit size rather than OOM.

**Acceptance tests:**

- A process emitting well beyond the cap completes without proportional heap growth and returns truthful omitted-byte metadata.
- stdout and stderr are independently bounded.
- Raw handles cannot exceed aggregate storage budget.
- UTF-8 output remains valid at truncation boundaries.

## SEC-03 — Timeout and abort kill only the shell, not its descendants

**Severity:** High  
**CWE:** CWE-400 / CWE-667  
**Evidence:** `src/llm/tools/bashTool.ts:28,33-40` spawns `bash -lc` and sends `SIGTERM` only to that child PID.

**Impact:** A command can start background/grandchild processes that continue running, writing files, consuming resources, or using the network after haze reports a timeout or the user presses Esc. This violates the practical meaning of cancellation even though arbitrary shell execution itself is intentional.

**Recommendation:**

- On POSIX, start bash in its own process group and signal the group (`-pid`), escalating to `SIGKILL` after a short grace period.
- On Windows, use a small platform-specific tree termination strategy (`taskkill /T /F` or equivalent).
- Record `signal`, `aborted`, `timedOut`, and whether forced termination was required.
- Resolve exactly once across `close`, `error`, timeout, and abort races.

**Acceptance tests:** Spawn a shell that creates a long-lived child writing a heartbeat file. After timeout and explicit abort, assert both shell and child stop and the result distinguishes timeout from user abort.

## SEC-04 — `grep` bypasses `.gitignore` for an explicitly named ignored file

**Severity:** High  
**CWE:** CWE-200 (Exposure of Sensitive Information)

**Evidence:**

- `grep` uses `prepareWorkspaceExisting(searchPath)` at `src/llm/hazeTools.ts:155`, which checks real workspace confinement but not ignored status.
- Unlike `readFile`, the schema has no explicit `allowIgnored` input.
- Ripgrep honors ignore rules during traversal but searches an ignored file when that file is passed explicitly. A manual probe against an ignored `ignored.txt` returned its contents.

**Impact:** The model can search directly named ignored secrets such as `.env`, generated credentials, or local state despite the documented “respect `.gitignore` by default” contract.

**Recommendation:** Replace the call with a grep-specific preparation that runs `assertNotIgnored` on the explicit root. Add an `includeIgnored: false` schema field only if the product intentionally supports explicit override; keep the default false and wording aligned with `readFile`/`listFiles`.

**Acceptance tests:**

- Traversal omits ignored files.
- Direct ignored file and direct ignored directory are rejected by default.
- Explicit override works only when supplied.
- Symlinks to outside the workspace remain rejected.

## SEC-05 — Skill reference symlinks escape the skill directory

**Severity:** High  
**CWE:** CWE-59 (Improper Link Resolution Before File Access)

**Evidence:** `src/skills/SkillLoader.ts:45-53` validates the lexical resolved path, then uses `stat` and `readFile`, both of which follow symlinks. It does not compare the real skill root and real reference path. `SKILL.md` itself can also be a symlink.

**Impact:** A copied, unpacked, or otherwise malicious skill can reference a symlink to `~/.ssh`, cloud credentials, project secrets, or another arbitrary local file. The `skill` tool then returns that content to the model/provider, contradicting the documented “references stay inside the skill directory” contract.

**Recommendation:**

- Resolve and compare `realpath(dir)`, `realpath(SKILL.md)`, and every reference.
- Reject symlinked skill files/references, or allow symlinks only when their final real path remains under the real skill root.
- Open with no-follow semantics where portable, and compare a post-open descriptor stat when practical to reduce check/use races.
- Keep the existing 50 KB reference cap; add a bounded `SKILL.md` size too.

**Acceptance tests:** direct file succeeds; `../` fails; absolute path fails; symlink to inside behaves according to chosen policy; symlink to outside always fails; oversized `SKILL.md` fails cleanly.

## SEC-06 — LSP file access does not enforce real workspace paths

**Severity:** Medium  
**CWE:** CWE-59

**Evidence:**

- `src/llm/lsp.ts:201` uses lexical `resolveWorkspacePath` only.
- `openDocument` reads the resolved path directly at `src/llm/lsp.ts:184`.
- `fromUri` converts any `file://` URI to a workspace-relative-looking string without checking whether the target is in the workspace.
- The LSP frame buffer and declared `Content-Length` are not capped (`src/llm/lsp.ts:119-136`).

**Impact:** A workspace symlink can cause haze to read and send an outside file to a configured language server. A server can also return outside-workspace locations as `../../...`, confusing later model behavior. A broken/malicious local server can grow the receive buffer indefinitely.

**Recommendation:** Reuse `prepareWorkspaceRead`/real-path confinement for document tools, including ignored-file policy. Reject or label outside-workspace returned locations. Add maximum header, frame, and aggregate buffer sizes and terminate malformed servers.

**Acceptance tests:** symlink escape is rejected; outside `file://` result is omitted or explicitly external; oversized/missing-header frames terminate the client and reject pending requests without heap growth.

## SEC-07 — MCP loading can hang a turn indefinitely and cannot be aborted

**Severity:** High (availability)  
**CWE:** CWE-400

**Evidence:** `src/llm/mcp.ts:29-45` awaits client creation and `client.tools()` sequentially without timeout or abort. `assembleRequestContext` runs this before `ToolLoopAgent` streaming starts; the idle timer in `runAgentTurn` is reset only afterward. The turn abort signal is not forwarded to MCP setup.

**Impact:** One unreachable or protocol-stalled server can block every turn indefinitely, contrary to README claims that an unreachable server is isolated and never blocks the agent. Esc may update local UI state but cannot stop the pending MCP setup.

**Recommendation:**

- Give each server a short discovery deadline and accept the turn abort signal.
- Load independent servers concurrently with a small concurrency cap; collect failures per server.
- Close partially created clients on timeout/error.
- Apply a deadline to `close()` as well so cleanup cannot hang the turn.

**Acceptance tests:** one hanging server times out while another loads; abort stops discovery promptly; partial clients close; built-ins remain available; elapsed time is bounded.

## SEC-08 — Remote credentials can be sent over plaintext HTTP without a warning

**Severity:** Medium  
**CWE:** CWE-319 (Cleartext Transmission of Sensitive Information)

**Evidence:** provider and MCP URL capture accepts any URL (`src/cli/commands/wizardPrompts.ts` and `wizardInput.ts`), and configured API keys/Authorization headers are sent to that endpoint. HTTP is required for common loopback model servers, so a blanket HTTPS-only rule would break the product.

**Impact:** A mistyped or intentionally remote `http://` endpoint sends credentials and prompts in cleartext over the network.

**Recommendation:** Keep HTTP for loopback/private local endpoints. For non-loopback hostnames/IPs, reject plaintext HTTP when a credential is configured or show one explicit setup-time warning requiring confirmation. This is configuration validation, not a per-command permission gate.

**Acceptance tests:** local `http://localhost`/loopback keyless setups remain easy; remote HTTP with a key is rejected or explicitly acknowledged; HTTPS is unchanged.

## Security items intentionally not findings

- **No bash confirmation gate:** intentional and appropriate for the documented expert audience.
- **Model prompt injection can cause tool use:** inherent to the chosen high-agency design. Existing project-context wording is useful defense-in-depth, not a sandbox.
- **User-configured stdio MCP/LSP processes can execute local code:** explicit integration behavior. The findings above concern hangs, path-policy consistency, and truthful isolation.
- **Public fetch content is untrusted:** the SSRF implementation is materially stronger than typical CLI fetch tools and had no confirmed bypass in this review.
