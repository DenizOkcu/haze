# Feature Specification: Image input (F03)

**Source**: `docs/product-review/features/F03-image-input.md` (2026-08-03 product review)
**Wave**: 2 · **Priority**: 5 · **Constitution**: v1.2.0

Users attach workspace images to their prompts by `@path` mention. haze sends
them as multipart user content, but only to providers explicitly marked
image-capable. Reads are byte-bounded, persisted sessions slim image bytes to
placeholders, and every failure is loud and actionable.

Note: the product roadmap sequences F04 (`@`-mentions) before F03 so the
attachment UX can be shared. F04 is not implemented yet; this spec therefore
includes the minimal image-only mention parsing F03 needs. General file
mentions, tab completion, and non-image attachments stay out of scope for F04.

## User Scenarios & Testing

### User Story 1 - Attach an image to a request (Priority: P1) 🎯 MVP

The user types `@shot.png fix this layout` (or pastes a path the terminal
inserted via drag-and-drop). With an image-capable provider active, the model
receives the text plus an image part and reasons about the screenshot.

Acceptance:

- AC1: with an image-capable provider, the turn's user message is multipart
  (`text` part + `file` part with the correct media type and bytes). Text-only
  prompts keep building plain string content (no behavior change).

### User Story 2 - Loud capability gating (Priority: P1)

If the active provider is not marked image-capable, attaching an image fails
before any model call with an actionable message naming the provider and the
fix (`/provider` toggle). Never a silent drop, never a provider 400 mid-turn.

Acceptance:

- AC2: with a non-capable provider, the same prompt fails before any model
  call with the actionable message.

### User Story 3 - Durable sessions without megabytes of base64 (Priority: P2)

Persisted session snapshots replace image parts with a short text placeholder
(`[image omitted from session: shot.png (image/png, 214 KB)…]`). Resume stays
protocol-safe and the model can ask the user to re-attach if needed.

Acceptance:

- AC4: the session written after an image turn contains the placeholder, not
  image bytes; resume renders/restores the placeholder text.

### Edge Cases

- Non-image binary/text paths mentioned with `@` produce a clear "not an
  image" error (AC5).
- Images larger than the byte budget are rejected with the limit named (AC3).
- More than the per-message attachment limit → error naming the limit.
- Mentions that resolve outside the workspace, or symlink-escape it, fail
  closed (Principle IV).
- `@tokens` that are not existing workspace paths (emails, handles, typos)
  remain literal prompt text.
- Image-only prompts (no other text) still produce a valid user message.
- Sessions written before this feature restore unchanged.

## Requirements

### Functional Requirements

- FR-01: `@path` tokens in interactive prompts are resolved against the
  workspace; existing files with an image extension (png, jpg, jpeg, gif,
  webp) become attachments. Nonexistent paths stay literal text.
- FR-02: Attachment reads are bounded by a named constant
  (`IMAGE_ATTACHMENT_BYTES`); oversize files fail naming the limit. At most
  `IMAGE_ATTACHMENTS_PER_MESSAGE` attachments per prompt (named constant).
- FR-03: Attachments are confined to the workspace via the shared real-path
  helpers; symlink escapes are rejected.
- FR-04: Providers gain an explicit `capabilities.images` flag (default: not
  capable). The `/provider` picker toggles it; `/settings` shows which
  configured providers are image-capable.
- FR-05: When attachments are present and the active provider is not
  image-capable, the turn fails before any model call with an actionable
  message naming the provider and the fix.
- FR-06: Turns with attachments build multipart user content (AI SDK
  `file` parts); turns without keep plain string content.
- FR-07: Session slimming replaces image file parts with a text placeholder
  (media type + byte count + filename) so JSONL stays small and resume stays
  protocol-safe.
- FR-08: The transcript shows a compact `🖼 name (size)` line per attachment;
  no binary dump.
- FR-09: Token/context estimates count image parts with a labeled bytes-based
  heuristic instead of serializing image bytes as text.
- FR-10: Headless `-p` prompts stay text-only (attachments are
  interactive-only in the MVP); `stream-json` events never carry image bytes.

### Key Entities

- **ImageAttachment**: workspace-relative display path, resolved real path,
  media type, byte count, raw bytes.
- **Provider capabilities**: `capabilities?: {images?: boolean}` on
  `HazeProviderSettings`; only explicit `true` enables images.

### Deliberate non-goals (this spec)

- General `@path` file mentions and tab completion (F04 territory).
- Model-initiated image reading through `readFile`, image generation,
  clipboard paste, haze-taken screenshots (brief "Out" list).
- Attaching files outside the workspace.
- gitignore enforcement for mentions: an `@path` mention is an explicit
  user-typed reference (the override itself); workspace/real-path confinement
  still applies. Documented in the module contract.

## Success Criteria

- Screenshot-driven UI iteration works end to end in the terminal.
- No text-only behavior changes; no silent drops anywhere.
- Session JSONL size is unaffected by image turns.
- All limits are named constants; all errors are actionable.
