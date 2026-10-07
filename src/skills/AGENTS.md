# src/skills/AGENTS.md

Last updated: 2026-10-07 for the 1.5.1 release (round-1 review fixes).

Markdown skill loading, registry, model-facing skill tool, and skill builder.

## Skill format contract

- Skills are directories containing `SKILL.md`.
- `SKILL.md` must start with YAML frontmatter delimited by `---`.
- Required frontmatter: `name` (letters/numbers/hyphens/underscores only) and non-empty `description`.
- The Markdown body is instructions only; skills do not execute code.
- Referenced files may be Markdown links or plain file-looking relative paths in the body.
- `SKILL.md` is capped at `SKILL_MARKDOWN_BYTES` (256 KB); references must stay inside the skill directory and be <= 50k bytes. Both `SKILL.md` and references are real-path-confined to the skill root so symlink escapes are rejected, and the shared secret-file policy (`isProtectedSecretPath`, lexical and real path) applies to both before any read — a skill cannot smuggle a protected secret as its body or a reference (CI-03). Aggregate allocation is bounded too: at most 20 references per skill and one aggregate reference byte budget, failing loudly instead of growing silently (CI-04).

## Loader/registry behavior

- `SkillLoader.ts` parses frontmatter, validates names/descriptions, discovers references, and loads referenced content.
- `SkillRegistry.ts` loads global skills from `~/.haze/skills` and project skills from `<workspace>/.haze/skills`. It returns active project-over-global `skills`, all valid `candidates`, and isolated `errors`. Project directories are real-path-confined to the workspace; same-scope duplicates keep the first sorted valid skill.
- `skillTools.ts` exposes a single model-facing `skill` catalog tool. Its catalog includes provenance. It returns instructions and available reference paths first, then one referenced file only when requested; project bodies/references are wrapped as untrusted repository content and escaped against closing-tag injection.
- `types.ts` defines loaded skill and registry shapes. Treat these as public within the codebase and tests. Plugin skills additionally carry `pluginName` and a namespaced `<plugin>:<skill>` runtime name with `global` source (kits install globally; content stays untrusted third-party).
- `plugins/package.ts` reads Agent Plugins 1.0.0 root manifests before Claude/Codex fallbacks and resolves local collection entries. Unknown portable fields are ignored with warnings; unsupported components never activate.
- `plugins/installer.ts` installs bounded, secret-free, non-symlinked local packages globally into `~/.haze/plugins` with hash ownership receipts/locking in `~/.haze/plugin-receipts`; installation never writes workspace content. Preserve modified/unowned content on rollback/removal. `extensions` namespaces (including the legacy `dev.haze.workspaceFiles`) are reported and ignored.
- `plugins/runtime.ts` activates only receipt-listed global plugins as untrusted third-party skills (global provenance); isolate invalid receipts/manifests/skills. Default and legacy custom skill paths remain package-confined. Never discover other agents' caches automatically. `/plugin` (`/kit` alias) refreshes interactive skills after install/remove; `/skills` must not directly delete plugin-owned skill directories.

## Builder behavior

Maintainability focus:

- Keep generated fallback skills deterministic and small so skill creation remains usable without configured providers/models.

- `builder/SkillBuilder.ts` creates a skill from name + natural-language description in one model pass when a model is configured. Its explicit scope selects either `~/.haze/skills` or `<workspace>/.haze/skills`; project targets and existing `.haze` ancestors must remain real-path-confined to the workspace.
- If no model is configured, builder must provide deterministic fallback content.
- Generated skill directory names must be filesystem-safe and stable enough for tests.

## UI/settings integration

- `/skills` is implemented in CLI command/wizard modules. The picker includes both candidates when a project skill shadows a global skill and labels their provenance. Creation always includes an explicit project/global scope step.
- Skill enabled overrides live in `config/skillSettings.ts` and `settings.json`; omitted scope means global for backward compatibility.
- Disabled skills should be absent from the model-facing catalog and not invocable as `/<skillName>`. Overrides are keyed by name and scope; disabling a shadowing project skill re-surfaces an enabled same-named global skill.

## Tests

Update `tests/skills/*` for loader, registry, skill tool, or builder changes. Cover project/global merge precedence, fallback after scoped disable, invalid-skill isolation, and both skill-directory and root symlink escapes. If the public skill contract changes, update `examples/skills/` and README/docs references.
