export type ToolFailureReasonCode =
  | 'old_text_missing'
  | 'old_text_not_unique'
  | 'overlapping_edits'
  | 'ignored_path'
  | 'ignore_check_unavailable'
  | 'secret_file_protected'
  | 'path_not_found'
  | 'not_a_file'
  | 'permission_denied'
  | 'outside_workspace'
  | 'binary_file'
  | 'existing_file_requires_overwrite'
  | 'write_chunk_too_large'
  | 'conflicting_write_modes'
  | 'append_target_missing'
  | 'invalid_line_range'
  | 'io_error'
  | 'file_too_large'
  | 'blocked_url'
  | 'background_limit'
  | 'background_not_allowed'
  | 'process_id_required'
  | 'process_not_found'
  | 'process_already_exited'
  | 'process_kill_failed'
  | 'output_expired'
  | 'aborted'
  | 'missing_executable'
  | 'scoped_instructions_discovered';

export type ToolDiffLine =
  | {type: 'add' | 'remove' | 'context'; oldLine?: number; newLine?: number; text: string}
  | {type: 'gap'; omittedLines: number}
  | {type: 'meta'; text: string};

export type ValidationKind = 'test' | 'typecheck' | 'lint' | 'build' | 'generic';

export type ValidationSummary = {
  kind: ValidationKind;
  status: 'passed' | 'failed' | 'timed_out' | 'unknown';
  failedFiles: string[];
  failedTests: string[];
  diagnostics: Array<{
    file?: string;
    line?: number;
    column?: number;
    severity: 'error' | 'warning';
    message: string;
  }>;
  summaryText: string;
  suggestedNextStep?: string;
  rawOutputTruncated: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null;
}

export function isValidationSummary(value: unknown): value is ValidationSummary {
  return isObject(value) && typeof value.summaryText === 'string' && Array.isArray(value.diagnostics);
}
