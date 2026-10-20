import type {SandboxDenial} from './diagnostics.js';

/**
 * Bounded in-memory audit log of sandbox denials observed this process.
 *
 * Post-hoc classification (stderr errno shapes) is the only signal both
 * backends give us — seatbelt fails operations with EPERM, bubblewrap makes
 * absent paths ENOENT — so every classified denial is recorded here and
 * surfaced to the user through several deterministic channels:
 *
 * 1. the shell result itself (`sandbox.denial` + `sandbox_boundary` reason),
 * 2. a one-time-per-path system message while the turn runs,
 * 3. the transcript tool line (`[sandbox: <kind> denied <path>]`),
 * 4. `/sandbox denials` on demand.
 *
 * The ring is capped (Constitution III): a runaway loop of denied commands
 * can never grow memory; the newest entries win. `resetSandboxDenialLog()`
 * is the test seam.
 */

export interface RecordedSandboxDenial {
  at: string;
  command: string;
  kind: SandboxDenial['kind'];
  pathHint?: string;
}

const DENIAL_LOG_LIMIT = 50;

const denials: RecordedSandboxDenial[] = [];

export function recordSandboxDenial(denial: Omit<RecordedSandboxDenial, 'at'>): void {
  denials.unshift({...denial, at: new Date().toISOString()});
  if (denials.length > DENIAL_LOG_LIMIT) denials.length = DENIAL_LOG_LIMIT;
}

export function listSandboxDenials(): readonly RecordedSandboxDenial[] {
  return [...denials];
}

export function resetSandboxDenialLog(): void {
  denials.length = 0;
}

/** Compact multi-line rendering for `/sandbox denials` and status cards. */
export function formatSandboxDenials(entries: readonly RecordedSandboxDenial[], limit = 10): string {
  if (entries.length === 0) return 'No sandbox denials recorded this session.';
  const shown = entries.slice(0, limit);
  return [
    `Sandbox denials (newest first, ${shown.length} of ${entries.length} shown):`,
    ...shown.map(entry => `  ${entry.at.slice(11, 19)} ${entry.kind} denied${entry.pathHint ? ` ${entry.pathHint}` : ''} — ${entry.command.slice(0, 60)}`),
  ].join('\n');
}
