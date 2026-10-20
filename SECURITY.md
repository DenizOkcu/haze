# Security policy

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest minor (`1.5.x`) | Yes — security fixes |
| Older minors and pre-1.0 (`0.x`) | No — upgrade required |

Security fixes are provided for the latest published minor release. Upgrade to the newest release before reporting an issue that may already have been fixed.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open a public issue for a suspected vulnerability and do not include credentials, private source code, or unredacted haze debug logs in a public report.

Include the affected version, operating system, reproduction steps, impact, and any suggested mitigation. Reports are handled on a best-effort basis by the project maintainer. There is no guaranteed response or remediation SLA.

## Threat model

haze is intended for attended use by an experienced developer on a single-user machine. It trusts the user and their global `~/.haze` configuration. Repository contents, project instructions and skills, fetched web content, MCP and LSP servers, and model output are untrusted inputs. A local attacker who already has access as the same operating-system user is outside the supported threat model.

haze does not use command confirmation gates. Shell classification is informational, and relevant commands may mutate or delete data. Workspace confinement, bounded input and output, URL validation, private local storage, prompt-injection framing, and user supervision reduce risk.

As of this release, model-initiated shell commands additionally run inside an **OS-level filesystem sandbox** where the platform allows it: Seatbelt (`sandbox-exec`) on macOS and bubblewrap (`bwrap`) on Linux. The default boundary grants read-write access to the workspace, the temp directory, and tool caches; read-only access to system tool directories, `~/.haze` and `~/.claude` (with credential files such as `settings.json`, `.credentials.json`, and session transcripts masked), and paths the user explicitly blessed with `@path` in the prompt (read-only, turn-scoped). Everything else is denied at the operating-system level, including home-directory secrets and sibling projects, and symlink traversal cannot escape because both backends evaluate canonical paths. The sandbox is confinement, not a permission gate: there are no approval dialogs, boundaries degrade visibly when no backend exists (Windows, restricted user namespaces), and `sandbox.mode: "on"` fails closed instead of running unsandboxed. Network egress stays allowed in the default profile because build tooling needs it; the `strict` profile denies it. The sandbox does not constrain the haze process itself, LSP/MCP servers, or resources like CPU and memory — supervision remains required.

The file tools carry one absolute exclusion: protected secret files (SSH keys, shell history files, `.env`/`.envrc` files, `*.pem`/`*.key`, and common home credential stores) are refused for reads and mutations before any filesystem access, including via symlinks, user-typed path exceptions, or ignore overrides. The `shell` tool has no command-level filtering for these paths; secret avoidance in shell is instructed through the system prompt and remains inside the attended-use supervision boundary. This layer is best-effort protection against casual and accidental access, not a defense against a deliberately malicious model — treat the operating-system account boundary as the real containment line.
