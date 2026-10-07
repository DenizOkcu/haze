# docs/

Static documentation site published at https://denizokcu.github.io/haze/.
The pages are hand-maintained HTML sharing `site.css` and `site.js`.

## Source of truth

Hand-rolled docs drift from code unless each page names what it mirrors.
When you change behavior in one of the source files below, update the
corresponding docs page in the same PR.

| Page | Mirrors |
|------|---------|
| `index.html` | `README.md` (feature list, install, safety model) |
| `quickstart.html` | `README.md` install/usage sections; `src/cli/index.ts` CLI flags |
| `commands.html` | `src/cli/commands/commands.ts` slash-command catalog |
| `tools.html` | `src/llm/hazeTools.ts` tool catalog; `src/llm/tools/**` implementations |
| `skills.html` | `src/skills/**` and `src/llm/systemPrompt.ts` skill guidance |
| `workflows.html` | `README.md` examples and `AGENTS.md` runtime contracts |

## Current release: 1.5.1

The public HTML pages document 1.5.1. Keep their npm version stamps and quickstart version example aligned with package metadata. Reasoning compatibility is described in `commands.html`; full transcript replay on width changes is described in `workflows.html` and the README. Historical migration plans, validation reports, and architecture reviews retain their original versions and dates.

## Regeneration

Long-term, `docs/*.html` should be generated from the source files (or from a
JSON snapshot captured by a script under `docs/build/`) so the mapping above is
enforced by CI rather than by contributor discipline. Until that script exists,
treat the table above as a manual checklist.
