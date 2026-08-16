# src/core/attachments/AGENTS.md

Last updated: 2026-08-17 for the 1.0.0 release.

User-mentioned paths for chat prompts: image attachments (`imageAttachments.ts`)
and read-blessings (`readBlessings.ts`). Both resolve from the same `@path` /
bare-path extraction; routing is by extension and stat result.

## Purpose

- `imageAttachments.ts` resolves image-extension mentions into bounded
  attachments, builds the multipart user message, and owns the provider
  capability gate.
- `readBlessings.ts` resolves the same mentions (non-image files and
  directories) into `BlessedPath` records the read tooling consults to skip
  workspace confinement for one turn.

## Contracts (shared extraction)

- Mention parsing is conservative: only candidates that resolve to an
  existing file become attachments or blessings. Emails/handles and
  nonexistent paths stay literal prompt text so ordinary prose is never
  mangled. Two forms are recognised:
  - Explicit `@token` mentions: any path-like token after `@`.
  - Bare paths: any token containing `/`. The separator keeps prose like
    "I named it cat.png" out; bare filenames still need `@`.
- A sentence-ending period (`@shot.png.` or `/path/foo.png.`) is dropped
  when the verbatim path does not exist, so the image is attached rather
  than silently left as text.
- Backslash escapes (`\ `, `\(`, …) are honoured so paths containing spaces
  — the default macOS screenshot filename is `Bildschirmfoto YYYY-MM-DD um
  HH.MM.SS.png` — resolve; the escape is removed for filesystem ops but
  kept in the captured token so the mention is stripped from the prompt
  exactly as typed.
- Mentions resolve to host paths: workspace-relative (including `../`),
  absolute, or `~/`. An `@` mention is an explicit user-typed reference, so
  unlike model-driven file tools there is no workspace confinement and the
  gitignore default does not apply. The real path only dedupes aliases
  (symlinks, `..` segments); `displayPath` is workspace-relative inside the
  project, `~/…` under the home directory, absolute otherwise.

## Contracts (image attachments)

- Routing: existing image-extension files attach; existing non-image paths
  stay literal text (no throw) so `readBlessings` can bless them; existing
  image-extension paths that are not regular files (e.g. a directory named
  `foo.png`) still fail loudly — that is a genuine attach-intent mismatch.
- Size (`IMAGE_ATTACHMENT_BYTES`) and per-message count
  (`IMAGE_ATTACHMENTS_PER_MESSAGE`) live in `core/limits.ts`;
  errors must keep naming the limit.
- Image capability is explicit per provider (`capabilities.images`), never
  inferred from URL or model names; `imageCapabilityError` takes the provider
  shape directly so this module stays settings/UI-free (constitution VI/VII).
- `userTurnMessage` returns a plain string message when there are no
  attachments: all text-only paths stay unchanged.
- `isImageFilePart`/`imageFilePartBytes` are shared by `core/agent`
  (token estimates) and `core/session` (slimming); do not serialize image
  bytes in either caller.
- Attached images are model-visible user input — the same trust class as pasted
  text, not untrusted fetched content. haze does not parse or execute them; it
  only reads the bytes, bounds them, and forwards them to a capable provider.

## Contracts (read-blessings)

- Image-extension paths are skipped here so an attached image is not also
  blessed for read.
- Mentions stay in the prompt text — the model needs the cue to know what
  to read. (Image attachments strip their mentions; blessings do not.)
- `BlessedPath` carries `realPath` and `isDirectory`. The check at the tool
  layer (`isPathBlessed`) allows exact matches and, for directories, any
  descendant path.
- Mutating tools never consult the bless set: a path mentioned to discuss or
  read stays non-editable.
- The same prompt-injection caveat as image attachments applies: pasted
  content can include sensitive paths. The user reviews the input box before
  submitting; that is the trust boundary.

## Tests

- `tests/core/attachments/imageAttachments.test.ts` covers mention parsing
  (explicit `@` and bare paths, including backslash-escaped spaces), prose
  safety, resolution errors, bounds, host-path resolution and alias dedupe,
  message assembly, and the capability gate.
- `tests/core/attachments/readBlessings.test.ts` covers blessing resolution
  and `isPathBlessed` boundary semantics.
- `tests/llm/tools/workspaceFile.test.ts` covers the tool-level bless
  exception (read bypass, mutation never bypasses).
