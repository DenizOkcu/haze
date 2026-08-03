# src/core/attachments/AGENTS.md

Last updated: 2026-08-03 for F03 image input.

User-attached images for chat prompts.

## Purpose

- `imageAttachments.ts` resolves `@path` mentions typed in the interactive
  chat into bounded image attachments, builds the multipart user message, and
  owns the provider capability gate.

## Contracts

- Mention parsing is conservative: only `@tokens` that resolve to an existing
  workspace file become attachments. Emails/handles and nonexistent paths stay
  literal prompt text so ordinary prose is never mangled. A sentence-ending
  period (`@shot.png.`) is dropped when the verbatim path does not exist, so
  the image is attached rather than silently left as text.
- Existing paths that are not allowlisted images (png, jpg, jpeg, gif, webp)
  fail loudly; nothing is silently dropped (constitution V/VII).
- Confinement reuses `utils/path.ts` workspace + real-path helpers, so symlink
  escapes are rejected. An `@` mention is an explicit user-typed reference —
  the gitignore default does not apply here, unlike model-driven file tools.
- Size (`IMAGE_ATTACHMENT_BYTES`) and per-message count
  (`IMAGE_ATTACHMENTS_PER_MESSAGE`) live in `core/limits/byteBudgets.ts`;
  errors must keep naming the limit.
- Image capability is explicit per provider (`capabilities.images`), never
  inferred from URL or model names; `imageCapabilityError` takes the provider
  shape directly so this module stays settings/UI-free (constitution VI/VII).
- `userTurnMessage` returns a plain string message when there are no
  attachments: all text-only paths stay unchanged.
- `isImageFilePart`/`imageFilePartBytes` are shared by `core/agent`
  (token estimates) and `core/session` (slimming); do not serialize image
  bytes in either caller.

## Tests

`tests/core/attachments/imageAttachments.test.ts` covers mention parsing,
resolution errors, bounds, workspace/symlink confinement, message assembly,
and the capability gate.
