# Security policy

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest minor (`1.0.x`) | Yes — security fixes |
| Older minors and pre-1.0 (`0.x`) | No — upgrade required |

Security fixes are provided for the latest published minor release. Upgrade to the newest release before reporting an issue that may already have been fixed.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open a public issue for a suspected vulnerability and do not include credentials, private source code, or unredacted haze debug logs in a public report.

Include the affected version, operating system, reproduction steps, impact, and any suggested mitigation. Reports are handled on a best-effort basis by the project maintainer. There is no guaranteed response or remediation SLA.

## Threat model

haze is intended for attended use by an experienced developer on a single-user machine. It trusts the user and their global `~/.haze` configuration. Repository contents, project instructions and skills, fetched web content, MCP and LSP servers, and model output are untrusted inputs. A local attacker who already has access as the same operating-system user is outside the supported threat model.

haze does not use command confirmation gates. Shell classification is informational, and relevant commands may mutate or delete data. Workspace confinement, bounded input and output, URL validation, private local storage, prompt-injection framing, and user supervision reduce risk, but haze is not a sandbox.
