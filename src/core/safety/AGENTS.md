# src/core/safety/AGENTS.md

Last updated: 2026-08-05 for the complete 1.0.0 release.

Safety classifiers and guards.

## Bash classifier

Current contract:

- Bash classification is metadata for display, logging, validation parsing, and output reduction. It does not block execution by itself.

- `bashClassifier.ts` classifies commands for display/metadata. It is not a permission gate.
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
- Block private, loopback, link-local, multicast, unspecified, and cloud-metadata addresses.
- Ordinary hostnames are resolved separately, but malformed colon-shaped IPv6 literals must fail closed rather than bypass literal-address checks.
- Re-validate after DNS resolution and each redirect hop.
- Keep error messages actionable without leaking internal network details unnecessarily.

## Tests

Update:

- `tests/core/bashClassifier.test.ts`
- `tests/core/urlGuard.test.ts`
- `tests/hazeTools/fetch.test.ts` for user-visible fetch behavior.
