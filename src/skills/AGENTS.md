# src/skills/AGENTS.md

Markdown skill loading, registry, model-facing skill tool, and skill builder.

## Skill format contract

- Skills are directories containing `SKILL.md`.
- `SKILL.md` must start with YAML frontmatter delimited by `---`.
- Required frontmatter: `name` (letters/numbers/hyphens/underscores only) and non-empty `description`.
- The Markdown body is instructions only; skills do not execute code.
- Referenced files may be Markdown links or plain file-looking relative paths in the body.
- References must stay inside the skill directory and be <= 50k bytes.

## Loader/registry behavior

- `SkillLoader.ts` parses frontmatter, validates names/descriptions, discovers references, and loads referenced content.
- `SkillRegistry.ts` loads global skills from `~/.haze/skills`; preserve deterministic handling of duplicate/invalid skills if changed.
- `skillTools.ts` exposes a single model-facing `skill` catalog tool. It returns instructions and available reference paths first, then one referenced file only when requested.
- `types.ts` defines loaded skill and registry shapes. Treat these as public within the codebase and tests.

## Builder behavior

- `builder/SkillBuilder.ts` creates a skill from name + natural-language description in one model pass when a model is configured.
- If no model is configured, builder must provide deterministic fallback content.
- Generated skill directory names must be filesystem-safe and stable enough for tests.

## UI/settings integration

- `/skills` is implemented in CLI command/wizard modules. Skill enabled overrides live in `config/skillSettings.ts` and `settings.json`.
- Disabled skills should be absent from the model-facing catalog and not invocable as `/<skillName>`.

## Tests

Update `tests/skills/*` for loader, registry, skill tool, or builder changes. If the public skill contract changes, update `examples/skills/` and README/docs references.
