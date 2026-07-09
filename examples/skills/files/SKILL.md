---
name: files
description: Use when the user asks for a careful file-inspection or file-editing workflow.
---

Use haze's built-in file tools rather than shell commands for file discovery and edits.

Workflow:
1. Use `listFiles` for project discovery.
2. Use `readFile` before editing existing files.
3. Prefer `editFile` for small exact changes.
4. Use `replaceLines` when exact replacement is ambiguous.
5. Use `writeFile` only for new files or intentional complete rewrites.

References:
- examples/file-editing.md
