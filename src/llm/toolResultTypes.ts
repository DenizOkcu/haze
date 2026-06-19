export type ToolFailureReasonCode =
  | 'old_text_missing'
  | 'old_text_not_unique'
  | 'overlapping_edits'
  | 'ignored_path'
  | 'existing_file_requires_overwrite'
  | 'invalid_line_range'
  | 'io_error'
  | 'blocked_url'
  | 'scoped_instructions_discovered';

export type ToolDiffLine = {type: 'add' | 'remove' | 'context'; oldLine?: number; newLine?: number; text: string};

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

export type StructuredToolFailure = {
  ok: false;
  toolName: string;
  path?: string;
  error: string;
  reasonCode?: ToolFailureReasonCode;
  recoverable: boolean;
  suggestedNextStep: string;
  recoveryTool?: string;
  recoveryInput?: unknown;
};

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null;
}

export function isStructuredToolFailure(value: unknown): value is StructuredToolFailure {
  return isObject(value) && value.ok === false && typeof value.toolName === 'string';
}

export function isValidationSummary(value: unknown): value is ValidationSummary {
  return isObject(value) && typeof value.summaryText === 'string' && Array.isArray(value.diagnostics);
}
