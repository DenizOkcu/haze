# src/config/AGENTS.md

Last updated: 2026-08-15 for the 0.11.0 release.

Runtime configuration, paths, context files, and provider/server settings.

## Responsibilities

- `paths.ts` defines haze's user-data roots such as `~/.haze` and global skills paths.
- `settings.ts` reads/writes `~/.haze/settings.json`, preserves legacy fields, and defines settings types.
- `providers.ts` normalizes configured providers, resolves active provider/model, handles `provider:model` selectors, and migrates legacy OpenRouter settings only when legacy data exists.
- `providerPresets.ts` contains UI presets for provider setup; do not make presets active implicitly. `modelDiscovery.ts` performs bounded OpenAI-compatible `/models` discovery for pickers and falls back to manual entry on failure.
- `contextFiles.ts` loads global and workspace `CLAUDE.md`/`AGENTS.md`, including lazy scoped nested files, display signatures, and read notifications for turn-time refresh.
- `lspSettings.ts`, `mcpSettings.ts`, and `skillSettings.ts` mirror settings-file management for optional integrations. Skill overrides are keyed by name plus scope (`global` or `project`); an omitted scope is legacy-compatible and means `global`.
- `inputHistory.ts` persists prompt history.
- `updateCheck.ts` checks npm/latest version; keep it non-fatal.
- `privateStorage.ts` is the single helper for `~/.haze` home-state writes: `0700` dirs, `0600` atomic/append files, and opportunistic tightening of pre-existing overly-broad modes. All settings/session/log/history/update state must go through it.
- `endpointSecurity.ts` validates provider/MCP endpoints: credentialed remote plaintext HTTP is rejected at configuration and runtime; loopback HTTP (`localhost`, `*.localhost`, `127/8`, `::1`) remains supported.

## Provider/model contract

- There is no default provider or model. `activeProvider(settings)` requires an explicit saved provider, and `activeModel(settings)` requires an explicit saved provider/model pair that still resolves.
- Do not introduce user-facing environment variables for provider/model config.
- Provider key order is saved provider key, then legacy OpenRouter `apiKey`, then local-provider placeholder behavior where the client layer expects it.
- Custom/local OpenAI-compatible providers may intentionally use placeholder keys.
- Model selectors use `provider:model` in haze settings/UI, not slash-separated provider IDs.
- Providers carry an optional `capabilities` object. Only `images` is read today: it is explicit-only (default off, never inferred from URL or model name) and gates whether attached images are sent to that provider (F03). Unknown capability keys round-trip through settings and provider upserts.

## Context file contract

- Startup order: `~/.claude/CLAUDE.md`, `~/.haze/AGENTS.md`, then ancestor `CLAUDE.md`/`AGENTS.md` from filesystem root to cwd.
- Nested files below cwd are loaded lazily by `readScopedContextFilesForPath` when file tools operate in their subtree.
- Context files carry optional `signature` values (`size:mtimeMs`) so callers can skip unchanged scoped guidance and reread changed guidance.
- Each file is capped by `MAX_CONTEXT_FILE_CHARS` and diagnostics estimate tokens/hash duplicate content.
- Display paths should be stable and user-friendly (`~`, relative cwd paths) because they appear in UI and model context.

## Settings safety

Current settings behavior:

- Missing `settings.json` reads as `{}`; malformed JSON or invalid known-field shape should throw an actionable error with the settings path.
- Settings writes should validate the public shape, preserve unknown fields, use temp-file-plus-rename style writes, and create/tighten files to `0600` under `0700` dirs via `privateStorage.ts`.
- Skill settings remain override-only. Enabling removes the matching name/scope override; disabling one scope must not affect a same-named skill in the other scope.
- `subagents` settings are passthrough-validated; `updateSubagentSettings` must preserve unknown root, subagent, and per-profile fields. Profiles and worker models are explicit—never inferred or silently replaced.
- Credentialed endpoints (provider keys, MCP Authorization headers) must pass `assertCredentialedEndpointSecure` before persisting or sending; reject non-loopback `http:` with credentials.

- Settings may contain API keys. Never log full settings or print secret fields unless the user explicitly asks and understands the risk.
- Write JSON/YAML atomically enough for normal CLI use and preserve unrelated existing fields where possible.
- haze assumes a single writer for `settings.json`. Writes are read-modify-write with an atomic temp-file-plus-rename, so the file cannot corrupt, but two concurrent haze instances can lose each other's updates. This is an accepted limitation (CR-027); do not add file locking unless a real need appears.
- Keep tests isolated from the real home directory by using temp dirs/mocks.

## Tests

Update matching `tests/config/*.test.ts` for any behavior change. Provider resolution and context-file discovery have important edge-case tests; run them directly before full validation.
