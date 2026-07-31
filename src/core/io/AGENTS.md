# src/core/io/AGENTS.md

Last updated: 2026-07-10 for the 0.9.0 release.

Bounded UTF-8 readers that cap work performed, not just text returned.

## Responsibilities

- `boundedRead.ts` provides `iterateBoundedUtf8Lines`, `readUtf8LinesPage`, and `readUtf8Prefix`.

## Contracts

- Stream files; never load a complete arbitrarily-large file into memory before applying limits.
- Bound each line at the provided `maxLineBytes` (default `TEXT_LINE_BYTES` from `core/limits`); mark oversized lines and surface truncation metadata instead of allocating unbounded line buffers.
- Keep UTF-8 valid at truncation boundaries.
- Exact line pages use a signature-validated LRU of sparse byte-offset indexes: at most 8 files and 8,192 checkpoints per file, with adaptive checkpoint stride. Keep these limits bounded, preserve synthetic final lines for empty/trailing-newline files, and never cache complete file contents.
- `readUtf8Prefix` is the single safe "read up to N bytes" primitive used by exact-mutation tools and bounded document loaders. Callers that need the whole file must check the returned `truncated` flag and reject, not silently operate on a prefix.

## Tests

Covered directly by `tests/core/io/boundedRead.test.ts` and indirectly by `tests/hazeTools/**`, `tests/llm/lsp.test.ts`, and edit-tool tests. Include later-page checkpoint reads and cache invalidation when the file signature changes.
