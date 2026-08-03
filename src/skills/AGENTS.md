# src/skills/AGENTS.md

Last updated: 2026-08-03 for project-local skills (F05).

Markdown skill loading, registry, model-facing skill tool, and skill builder.

## Skill format contract

- Skills are directories containing `SKILL.md`.
- `SKILL.md` must start with YAML frontmatter delimited by `---`.
- Required frontmatter: `name` (letters/numbers/hyphens/underscores only) and non-empty `description`.
- The Markdown body is instructions only; skills do not execute code.
- Referenced files may be Markdown links or plain file-looking relative paths in the body.
- `SKILL.md` is capped at `SKILL_MARKDOWN_BYTES` (256 KB); references must stay inside the skill directory and be <= 50k bytes. Both `SKILL.md` and references are real-path-confined to the skill root so symlink escapes are rejected.

## Loader/registry behavior

- `SkillLoader.ts` parses frontmatter, validates names/descriptions, discovers references, and loads referenced content.
- `SkillRegistry.ts` loads global skills from `~/.haze/skills` and project skills from `<workspace>/.haze/skills`. It returns active project-over-global `skills`, all valid `candidates`, and isolated `errors`. Project directories are real-path-confined to the workspace; same-scope duplicates keep the first sorted valid skill.
- `skillTools.ts` exposes a single model-facing `skill` catalog tool. Its catalog includes provenance. It returns instructions and available reference paths first, then one referenced file only when requested; project bodies/references are wrapped as untrusted repository content and escaped against closing-tag injection.
- `types.ts` defines loaded skill and registry shapes. Treat these as public within the codebase and tests.

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
