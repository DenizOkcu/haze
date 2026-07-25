# src/core/io/AGENTS.md

Last updated: 2026-07-10 for the security/correctness remediation (unreleased).

Bounded UTF-8 readers that cap work performed, not just text returned.

## Responsibilities

- `boundedRead.ts` provides `iterateBoundedUtf8Lines`, `readUtf8LinesPage`, and `readUtf8Prefix`.

## Contracts

- Stream files; never load a complete arbitrarily-large file into memory before applying limits.
- Bound each line at the provided `maxLineBytes` (default `TEXT_LINE_BYTES` from `core/limits`); mark oversized lines and surface truncation metadata instead of allocating unbounded line buffers.
- Keep UTF-8 valid at truncation boundaries.
- `readUtf8Prefix` is the single safe "read up to N bytes" primitive used by exact-mutation tools and bounded document loaders. Callers that need the whole file must check the returned `truncated` flag and reject, not silently operate on a prefix.

## Tests

Covered indirectly by `tests/hazeTools/**`, `tests/llm/lsp.test.ts`, and edit-tool tests.
