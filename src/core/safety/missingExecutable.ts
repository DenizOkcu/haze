/**
 * Bounded, generic diagnostic for missing executables.
 *
 * When a shell command fails because an executable is not on PATH, this derives
 * a precise, safe blocker: the executable name and a generic recovery order. It
 * never returns raw stderr/command text and contains no dependency-specific
 * branching (no special cases for Git, Python, Docker images, etc.).
 *
 * The recovery order is generic and safe:
 *   1. an already-available alternative (versioned/similarly-named command);
 *   2. the project's own manifest/package file + a project-local install;
 *   3. a system install only with explicit user consent (deferred — see below).
 *
 * Product decision (deferred): a system-install permission model is not defined
 * here. We never silently modify a user-managed toolchain. The diagnostic asks
 * for consent and reports the blocker; it does not perform the install.
 */

export interface MissingExecutableDiagnostic {
  /** Best-effort name of the executable that was not found. */
  executable: string;
  /** Generic, dependency-agnostic next step (bounded, no raw command/stderr). */
  suggestedNextStep: string;
}

const NOT_FOUND_PATTERNS: RegExp[] = [
  /:\s*command not found\b/i,
  /\bcommand not found:\s*/i,
  /\bnot found\s*$/i,
  /No such file or directory\b/i,
];

/** Extract the executable name from a "not found" diagnostic line, generically. */
function executableFromMessage(line: string): string | undefined {
  // `zsh:1: command not found: NAME` / `command not found: NAME` (checked first
  // so the line-number colon in the zsh form is not captured).
  const m2 = line.match(/command not found:\s*([^\s]+)/i);
  if (m2?.[1]) return m2[1];
  // `bash: line 1: NAME: command not found` / `bash: NAME: command not found`
  const m = line.match(/:\s*([^\s:]+):\s*command not found/i);
  if (m?.[1] && !/^\d+$/.test(m[1])) return m[1];
  // `NAME: not found` / `NAME: command not found`
  const m3 = line.match(/^\s*([^\s:]+):\s*(?:command )?not found\s*$/i);
  if (m3?.[1]) return m3[1];
  return undefined;
}

function firstCommandToken(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/);
  for (const raw of tokens) {
    // Skip wrappers and environment-variable assignments (e.g. `env FOO=1 cmd`).
    if (/^(env|sudo|command|nohup|exec|time)$/i.test(raw) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue;
    const cleaned = raw.replace(/^.+\//, '').replace(/^['"]|['"]$/g, '');
    return cleaned || undefined;
  }
  return undefined;
}

/**
 * Detect a missing-executable failure from a bounded command + reduced stderr +
 * exit code. Returns undefined when the failure is not a missing-executable
 * failure or no executable name can be derived.
 */
export function detectMissingExecutable(input: {command: string; code: number | null; stderr: string}): MissingExecutableDiagnostic | undefined {
  const looksMissing = input.code === 127 || NOT_FOUND_PATTERNS.some(pattern => pattern.test(input.stderr));
  if (!looksMissing) return undefined;
  const byLine = input.stderr.split(/\r?\n/).map(executableFromMessage).find(Boolean);
  const executable = byLine ?? firstCommandToken(input.command);
  if (!executable) return undefined;
  return {
    executable,
    suggestedNextStep: `Command '${executable}' was not found. First check whether a versioned or similarly-named alternative is already installed, then add it to the project's manifest/package file and install project-locally, or ask for explicit consent before installing into the system environment. Report this as blocked if no safe option is available.`,
  };
}

/**
 * Project the diagnostic into the bounded fields carried in safe tool output /
 * events. Only the executable name and reasonCode are exposed — never stderr or
 * the full command.
 */
export function missingExecutableFields(diagnostic: MissingExecutableDiagnostic): {reasonCode: 'missing_executable'; missingExecutable: string} {
  return {reasonCode: 'missing_executable', missingExecutable: diagnostic.executable};
}
