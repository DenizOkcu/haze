import type {ContextFile} from '../../config/contextFiles.js';
import type {HazeSettings} from '../../config/settings.js';
import {activeProvider} from '../../config/providers.js';
import {imageAttachmentLine} from '../commands/formatters.js';
import {imageCapabilityError, IMAGE_ONLY_PROMPT_TEXT, resolveImageAttachments} from '../../core/attachments/imageAttachments.js';
import {resolveReadBlessings} from '../../core/attachments/readBlessings.js';
import type {TurnExecutionOptions} from '../commands/streaming.js';

/**
 * Pure user-input policies extracted from ChatScreen so they are unit-testable
 * outside React (architecture-review round 1): attachment gating (F03), the
 * paused-goal recovery-command classification (SU-04), the session
 * model-selection patch policy, and the context-file signature map.
 */

/** F03: resolve @image mentions into attachments, gated on provider image capability. */
export async function prepareUserInput(value: string, settings: HazeSettings): Promise<{value: string; displayValue?: string; options: TurnExecutionOptions; error?: string} | undefined> {
  let resolved;
  try {
    resolved = await resolveImageAttachments(value);
  } catch (error) {
    return {value: '', options: {}, error: error instanceof Error ? error.message : String(error)};
  }
  const blessed = await resolveReadBlessings(resolved.text);
  if (resolved.attachments.length === 0 && blessed.blessedPaths.length === 0) return {value, options: {}};
  const gateError = imageCapabilityError(activeProvider(settings));
  if (resolved.attachments.length > 0 && gateError) {
    return {value: '', options: {}, error: gateError};
  }
  const displayValue = [resolved.text, ...resolved.attachments.map(imageAttachmentLine)].filter(Boolean).join('\n');
  return {
    value: resolved.text || IMAGE_ONLY_PROMPT_TEXT,
    displayValue,
    options: {attachments: resolved.attachments, blessedPaths: blessed.blessedPaths},
  };
}

/** SU-04: recovery/configuration commands keep the paused-goal resume affordance alive. */
export function isPausedGoalRecoveryCommand(mode: string, value: string): boolean {
  return mode !== 'chat' || /^(?:\/compact|\/model|\/provider|\/settings|\/themes|\/resume|\/sessions)\b/.test(value.trim());
}

/**
 * Preserve a resumed session's model selection across unrelated settings
 * writes: the patched fields win, untouched fields keep the current selection.
 */
export function mergeSettingsSelection(next: HazeSettings, current: {provider?: string; model?: string}, patch?: HazeSettings): HazeSettings {
  if (!patch) return next;
  return {
    ...next,
    provider: 'provider' in patch ? next.provider : current.provider,
    model: 'model' in patch ? next.model : current.model,
  };
}

/** Signature map for context files (path → `size:mtimeMs`), shared by startup and /context refresh. */
export function contextFileSignatureMap(files: readonly ContextFile[]): Map<string, string> {
  return new Map(files.flatMap(file => file.signature ? [[file.path, file.signature] as const] : []));
}

/**
 * One-key resume kind: an incomplete-goal checkpoint restarts the supervisor
 * from its checkpoint; anything else continues the idle-stall retry pool.
 */
export function resumeKindFor(resume: {kind: 'model-stream-idle' | 'incomplete-goal'; retryAttempt: number; checkpoint?: unknown}): {kind: 'incomplete-goal'; checkpoint: unknown} | {kind: 'model-stream-idle'; retryAttempt: number} {
  return resume.kind === 'incomplete-goal' && resume.checkpoint
    ? {kind: 'incomplete-goal' as const, checkpoint: resume.checkpoint}
    : {kind: 'model-stream-idle' as const, retryAttempt: resume.retryAttempt};
}
