# Implementation Plan: Image input (F03)

**Branch baseline**: `main` @ 086a649 · **Spec**: `specs/003-image-input/spec.md`

## Summary

Add user-message image attachments via `@path` mentions in the interactive
chat: bounded reads, explicit per-provider capability gating, multipart turn
assembly, session slimming to placeholders, and honest display. Text-only
paths stay byte-identical.

## Technical Context

- **Language/Stack**: strict TypeScript ESM, Node >=22, AI SDK v7
  (`UserContent = string | Array<TextPart | ImagePart | FilePart>`,
  `FilePart = {type: 'file', data, mediaType, filename?}`).
- **Storage**: `~/.haze/settings.json` via `config/settings.ts` (passthrough
  schemas already preserve unknown fields); session JSONL via
  `core/session/` slimming.
- **Testing**: Vitest; `tests/<area>` mirrors `src/<area>`.

## Constitution Check (pre-design)

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Light guardrails | ✅ | No new gates; capability check is configuration honesty, not a permission dialog. |
| II. Minimal core | ✅ | No new tools, no new workflow; one small core module + config flag. |
| III. Bounded resources | ✅ | `IMAGE_ATTACHMENT_BYTES`, `IMAGE_ATTACHMENTS_PER_MESSAGE` named constants in `src/core/limits`; size checked via `stat` before read. |
| IV. Real-path boundaries | ✅ | Attachments reuse `resolveWorkspacePath`/`assertRealPathInsideWorkspace`. Mention typed by the user acts as the explicit reference (gitignore not enforced — documented). |
| V. Truthful status | ✅ | Attachment failures happen before the turn: no model call, no turn started, explicit system message. |
| VI. UI-agnostic core | ✅ | `src/core/attachments/` has no React/Ink/provider imports; settings are passed in explicitly (pure capability check). |
| VII. Explicit configuration | ✅ | Capability default is *not capable*; no inference from URL/model name; loud error names the fix. |
| VIII. Private durable state | ✅ | Slimming adds an image-part case before JSONL write; placeholders keep resume protocol-safe; writes still go through `privateStorage`. |
| IX. Delegation | ✅ | Not touched; subagent/fleet prompts carry no attachments. |

No violations → no Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

- `specs/003-image-input/{spec,plan,tasks}.md` (these files)

### Source Code (single project)

New module:

- `src/core/attachments/imageAttachments.ts` — mention extraction,
  workspace-confined resolution + bounded read, media-type allowlist,
  multipart user-message assembly, capability gate (pure).
- `src/core/attachments/AGENTS.md` — module contract.

Touched modules:

- `src/core/limits/byteBudgets.ts` — `IMAGE_ATTACHMENT_BYTES`,
  `IMAGE_ATTACHMENTS_PER_MESSAGE`.
- `src/config/settings.ts` — `capabilities?: {images?: boolean}` on
  `HazeProviderSettings` + schema entry.
- `src/config/providers.ts` — preserve `capabilities` in `normalizeProvider`;
  `providerImageCapable()`.
- `src/core/agent/contextBudget.ts` — image-aware `estimateValueTokens`
  (bytes/heuristic instead of serializing bytes); heuristic constant lives
  here next to `DEFAULT_CHARS_PER_TOKEN`.
- `src/core/session/sessionSlimming.ts` — image `file` part → text
  placeholder.
- `src/cli/commands/streaming.ts` — `TurnExecutionOptions.attachments`;
  first-attempt user message built by shared `userTurnMessage()`.
- `src/cli/commands/chat.tsx` — resolve mentions per turn, capability gate,
  display value with `🖼` lines.
- `src/cli/commands/formatters.ts` — shared `formatBytes()` (moved from
  `logsCommand.ts`, DRY) + image attachment line formatter.
- `src/cli/commands/wizardActions.ts`, `providerWizard.ts`,
  `wizardDispatch.ts`, `wizardSuggestions.ts` — mark/clear image-capable
  toggle in `/provider`.
- `src/cli/commands/settingsSummary.ts` — image capability per provider.
- `src/cli/commands/commandHelp.ts` — `/provider` description.
- Docs: `README.md`, `CHANGELOG.md`, `docs/index.html`, nested AGENTS.md
  contracts (`src/core/session`, `src/core/limits`, `src/config`).

## Design notes

1. **Mention parsing** is deliberately conservative: `@token` where the token
   looks path-like (`[\w./~-]+`, contains `.` or `/`). Tokens that do not
   resolve to an existing workspace file stay literal text (emails, handles).
   Existing paths with a non-image extension fail loudly (AC5).
2. **Resolution returns cleaned text + attachments**; an image-only prompt
   falls back to a minimal "see attached" text part so every provider gets a
   valid message.
3. **Capability check** is a pure function over the provider shape so it is
   testable without settings I/O: `imageCapabilityError(provider | undefined)`.
4. **Session placeholder** is a `text` part (not a neutered `file` part) so
   resumed conversations remain valid `ModelMessage` values for any provider.
5. **Token estimate**: image parts count as `ceil(bytes / 750)` (labeled
   heuristic); prevents JSON-serializing megabytes of image data during
   budget checks and `/context` breakdowns.

## Post-design Constitution re-check

Re-verified after design: all rows still ✅. The only judgment call —
gitignore not enforced for explicit user mentions — is documented in spec
(non-goals) and the module AGENTS.md; Principle IV's real-path confinement
holds.
