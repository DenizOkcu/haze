export function buildInitPrompt() {
  return `Initialize this repository for Haze by creating a best-practice AGENTS.md file.

Explore the codebase first, respecting .gitignore:
1. Start with exactly one listFiles call from the workspace root. Do not announce that you are starting before the tool call.
2. After listFiles returns, do not call listFiles with the same input again. Immediately read the files needed to understand project conventions, commands, architecture, and release workflow. Usually read package/config files, README, AGENTS.md if present, and key source entrypoints.
3. Do not read ignored files unless truly necessary.

Create or update AGENTS.md at the workspace root. It should be concise and useful for future coding agents. Include sections when known:
- Project overview
- Common commands for install, development, typecheck, build, test, lint, release
- Architecture and important directories
- Coding conventions
- Tooling and package manager notes
- Testing/validation expectations
- Safety notes or files/directories to avoid

If AGENTS.md already exists, preserve useful existing instructions and improve them. After writing it, summarize what you learned and what you wrote.`;
}
