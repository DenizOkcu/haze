export function buildInitPrompt() {
  return `Initialize this repository for Haze by creating a best-practice AGENTS.md file.

Explore the codebase first, respecting .gitignore, but keep this quick and minimal:
1. Start with exactly one listFiles call from the workspace root. Do not announce that you are starting before the tool call.
2. Do not use bash for discovery unless package metadata is missing. Do not grep/find the tree for this command.
3. After listFiles returns, read only the small set needed to understand conventions: package/config files, README, existing AGENTS.md if present, and at most three key source entrypoints/directories.
4. Do not call listFiles with the same input twice. Do not read the same path repeatedly. Do not read speculative files; list the parent first if unsure.
5. Aim to finish in 12 tool calls or fewer. Do not read ignored files unless truly necessary.

Create or update AGENTS.md at the workspace root. It should be concise and useful for future coding agents. Include sections when known:
- Project overview
- Common commands for install, development, typecheck, build, test, lint, release
- Architecture and important directories
- Coding conventions
- Tooling and package manager notes
- Testing/validation expectations
- Safety notes or files/directories to avoid

If AGENTS.md already exists, preserve useful existing instructions and improve them with targeted editFile/replaceLines edits. Do not rewrite the entire file unless it is missing or unusable. After writing it, summarize only the change and validation status.`;
}
