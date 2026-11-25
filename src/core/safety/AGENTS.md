# src/core/safety/AGENTS.md

Safety classifiers and guards.

## Shell classifier

Current contract:

- Shell classification is metadata for display, logging, validation parsing, and output reduction. It does not block execution by itself.

## Secret redaction

- `redaction.ts` (`redactSecrets`, `looksLikeSecret`, `redactUnknown`) masks token-shaped secrets as `[redacted:<kind>]` in sessions and `--debug` logs: `sk-`, `glpat-`, `npm_`, `github_pat_` and `gh[pousr]_`, AWS key-id and secret pairs (a bare secret only next to its key id), `xox*-` Slack, JWT, `Bearer` (any case), `AIza`, `GOCSPX-`, and Stripe `sk_`/`rk_` keys, plus URLs with embedded credentials.
- It is pattern-based, not a guarantee: add a row to `SECRET_PATTERNS` and a case to `tests/core/redaction.test.ts` when a new token shape matters.

- `shellClassifier.ts` classifies commands for display/metadata. It is not a permission gate.
- Keep classification conservative but non-blocking.
- Traits/risk labels should be explainable from the command text and stable enough for tests.
- Do not add interactive confirmation behavior here; that belongs in UI/extensions if ever added.

## Missing-executable diagnostic

- `missingExecutable.ts` derives a bounded, dependency-agnostic blocker when a
  command fails because an executable is missing (exit 127 / "not found").
- It exposes only the executable name and a generic recovery order (alternative
  → project manifest/local install → consent-gated system install → precise
  blocker), never raw stderr/command text.
- No dependency-specific branching. System install is never performed silently;
  the system-install permission model is deferred (documented in the module).

## URL guard

- `urlGuard.ts` enforces the `fetch` tool's SSRF boundary.
- Allow only documented public `http`/`https` targets.
- Block private, loopback, link-local, multicast, unspecified, and cloud-metadata addresses, including their IPv6 forms (IPv4-mapped, NAT64 `64:ff9b::/96`, Teredo, 6to4, unique-local, link-local, multicast).
- Ordinary hostnames are resolved separately, but malformed colon-shaped IPv6 literals must fail closed rather than bypass literal-address checks.
- Re-validate after DNS resolution and each redirect hop.
- Keep error messages actionable without leaking internal network details unnecessarily.

## Tests

Update:

- `tests/core/shellClassifier.test.ts`
- `tests/core/urlGuard.test.ts`
- `tests/hazeTools/fetch.test.ts` for user-visible fetch behavior.
