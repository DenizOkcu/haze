# Plugin and marketplace interoperability

Researched against official documentation on 2026-10-07. This development change
adds local, skills-focused plugin consumption; it is not a claim that every host's
plugin runtime behaves identically.

## Official sources

- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference)
- [OpenAI plugin packaging and marketplace metadata](https://developers.openai.com/plugins/build/plugins)
- [Agent Plugins 1.0.0 specification](https://agent-plugins.org/specification)
- [Agent Skills specification](https://agentskills.io/specification)

Agent Plugins defines portable package metadata, skills and MCP, **not** a universal
marketplace, hooks or agent-definition format. Skills-only clients can adopt the
package format without activating MCP.

## One package, shared content, host-specific catalogs

```text
collection/
├── .claude-plugin/marketplace.json
├── .agents/plugins/marketplace.json
└── kits/example/
    ├── plugin.json
    ├── .claude-plugin/plugin.json
    └── skills/review/SKILL.md
```

Portable `plugin.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "example",
  "version": "1.0.0",
  "description": "Shared review instructions"
}
```

The Claude companion uses the same metadata without `$schema`. Its manifest is
optional for standard-layout plugins; Haze infers a missing manifest name from the
selected collection entry or directory name and reports that inference. If present,
a manifest must have a name. Portable root manifests require the explicit schema and
win over legacy `.claude-plugin` and `.codex-plugin` manifests, even when malformed
(the loader must not silently fall back).

Claude catalog:

```json
{
  "name": "team-tools",
  "owner": {"name": "Example Team"},
  "plugins": [{"name": "example", "source": "./kits/example"}]
}
```

OpenAI catalog:

```json
{
  "name": "team-tools",
  "interface": {"displayName": "Team Tools"},
  "plugins": [{
    "name": "example",
    "source": {"source": "local", "path": "./kits/example"},
    "category": "Productivity",
    "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"}
  }]
}
```

Paths resolve from the **collection root**, not from the metadata directory.
OpenAI accepts local path strings too, but separate projections avoid passing
OpenAI-only policy fields to strict Claude validation. Both catalogs in `haze-kits`
reference the same package; workflow instructions are not duplicated per host.

## Haze support matrix

| Feature | Behavior |
| --- | --- |
| Root Agent Plugins manifest | Locally validates 1.0.0 core fields; unknown top-level fields warn and are ignored |
| Claude/Codex compatibility manifest | Fallback when no canonical root manifest exists |
| Standard-layout manifest-less Claude skills | Name inference with warning; no inferred portable conformance |
| `skills/<name>/SKILL.md` | Immediate-child discovery, namespaced `<plugin>:<skill>`, untrusted third-party provenance (globally installed) |
| Legacy Claude `skills` paths | Confined extra roots or individual skill directories, no recursive scanning |
| Local catalogs | Explicit named selection from Claude/OpenAI catalogs; no automatic activation |
| Remote/git marketplace entries | Not fetched; clone their plugin repository and install locally |
| Marketplace installation/authentication policy | Not adopted; installation is an explicit Haze action |
| Hooks, MCP, agents, commands, LSP, other extensions | Reported/ignored; never activated by plugin installation |
| Host-specific skill frontmatter, shell preprocessing, argument substitution | Not emulated; rely only on supported Markdown instructions and ordinary tools |
| Bundled executables | Copied with normalized executable bit, never executed during installation |
| Global plugin activation and automatic updates | Plugins install globally under `~/.haze/plugins`; automatic updates are not implemented |

Haze exposes the actual installed plugin root and skill directory as metadata in the
`skill` tool result. This lets the agent locate bundled scripts without guessing.
It does not export/expand Claude runtime variables, launch plugin subprocesses or
implement a portable MCP environment. Existing standalone project/global skill
precedence and enable/disable behavior remain unchanged.

Packages containing protected secret names, symlinks, special files or content above
Haze's entry/byte limits are refused. This is stricter than hosts that allow contained
symlinks. Skill references retain Haze's skill-directory confinement and byte budgets.

## Installation scope

Plugins install globally: package files live in `~/.haze/plugins`, receipts in
`~/.haze/plugin-receipts`. Installation never writes workspace content. The former
`extensions.dev.haze.workspaceFiles` mapping (hash-verified copies into `.specify`
locations) is no longer supported; such extensions are reported and ignored. Kits
that need project assets ship an explicit setup skill whose instructions copy files
from `~/.haze/plugins/<name>` using normal agent tools.

An exclusive lock serializes normal installer operations. Uninstall deletes unchanged
owned files only. Modified/unowned retained packages stop activating after receipt
removal. Ordinary rollback preserves edited/replaced files, but hostile concurrent
filesystem races and crash recovery are not sandboxed.

## Validation evidence

The migrated Spec Kit package was checked using the installed official Claude CLI:
marketplace and plugin validation both passed without warnings. The installed Codex
CLI successfully added the local marketplace, listed `speckit@haze-kits`, and installed
it using a disposable home/config profile. No real user marketplace/config was changed.

Haze integration exercises real CLI collection selection, installation, idempotency,
loader compatibility, Bash feature/plan scripts, uninstall and user-artifact preservation.
These checks validate packaging and local workflow assets, **not** end-to-end model
execution on Claude/Codex or every third-party agent. The upstream network-dependent
generator was not rerun; the migration reused hash-verified existing payloads and tests
check shared generator metadata output.
