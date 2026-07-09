# src/core/safety/AGENTS.md

Last updated: 2026-07-09.

Safety classifiers and guards.

## Bash classifier

Current contract:

- Bash classification is metadata for display, logging, validation parsing, and output reduction. It does not block execution by itself.

- `bashClassifier.ts` classifies commands for display/metadata. It is not a permission gate.
- Keep classification conservative but non-blocking.
- Traits/risk labels should be explainable from the command text and stable enough for tests.
- Do not add interactive confirmation behavior here; that belongs in UI/extensions if ever added.

## URL guard

- `urlGuard.ts` enforces the `fetch` tool's SSRF boundary.
- Allow only documented public `http`/`https` targets.
- Block private, loopback, link-local, multicast, unspecified, and cloud-metadata addresses.
- Re-validate after DNS resolution and each redirect hop.
- Keep error messages actionable without leaking internal network details unnecessarily.

## Tests

Update:

- `tests/core/bashClassifier.test.ts`
- `tests/core/urlGuard.test.ts`
- `tests/hazeTools/fetch.test.ts` for user-visible fetch behavior.
