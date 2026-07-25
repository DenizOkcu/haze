# src/skills/AGENTS.md

Last updated: 2026-07-10 for the security/correctness remediation (unreleased).

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
- `SkillRegistry.ts` loads global skills from `~/.haze/skills` and returns `{skills, errors}`: directories are iterated in sorted order, each skill directory is real-path-confined to the skills root, and invalid/duplicate skills are isolated (first valid wins) so unrelated skills and built-ins stay usable.
- `skillTools.ts` exposes a single model-facing `skill` catalog tool. It returns instructions and available reference paths first, then one referenced file only when requested.
- `types.ts` defines loaded skill and registry shapes. Treat these as public within the codebase and tests.

## Builder behavior

Maintainability focus:

- Keep generated fallback skills deterministic and small so skill creation remains usable without configured providers/models.

- `builder/SkillBuilder.ts` creates a skill from name + natural-language description in one model pass when a model is configured.
- If no model is configured, builder must provide deterministic fallback content.
- Generated skill directory names must be filesystem-safe and stable enough for tests.

## UI/settings integration

- `/skills` is implemented in CLI command/wizard modules. Skill enabled overrides live in `config/skillSettings.ts` and `settings.json`.
- Disabled skills should be absent from the model-facing catalog and not invocable as `/<skillName>`.

## Tests

Update `tests/skills/*` for loader, registry, skill tool, or builder changes. If the public skill contract changes, update `examples/skills/` and README/docs references.
