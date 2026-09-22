import type {ValidationSummary} from '../../../llm/toolResultTypes.js';

function groupDiagnostics(summary: ValidationSummary) {
  const grouped = new Map<string, ValidationSummary['diagnostics']>();
  for (const diagnostic of summary.diagnostics) {
    const key = diagnostic.file ?? '(unknown file)';
    grouped.set(key, [...(grouped.get(key) ?? []), diagnostic]);
  }
  return grouped;
}

/** Inline cap for small raw output kept alongside the summary (RT-04). */
const INLINE_RAW_CHARS = 800;
const INLINE_RAW_LINES = 12;

/** Small failing-command output is the diagnostic itself (RT-04): keep it inline so a readToolOutput round-trip (a full model step) is saved. */
function inlineRawLines(raw: string): string[] {
  if (raw.length === 0 || raw.length > INLINE_RAW_CHARS) return [];
  const lines = raw.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
  return lines.length === 0 || lines.length > INLINE_RAW_LINES ? [] : lines;
}

export function renderValidationReduction(summary: ValidationSummary, rawHandle?: string, raw = '') {
  const lines: string[] = [summary.summaryText];
  if (summary.failedTests.length) {
    lines.push('', 'failed tests:');
    for (const test of summary.failedTests.slice(0, 10)) lines.push(`  - ${test}`);
  }
  const grouped = groupDiagnostics(summary);
  if (grouped.size) {
    lines.push('', 'diagnostics:');
    let emitted = 0;
    for (const [file, diagnostics] of grouped) {
      if (emitted >= 20) break;
      lines.push(file);
      for (const diagnostic of diagnostics) {
        if (emitted >= 20) break;
        const loc = diagnostic.line != null ? `${diagnostic.line}${diagnostic.column != null ? `:${diagnostic.column}` : ''}` : '?';
        lines.push(`  ${loc} ${diagnostic.severity} ${diagnostic.message}`);
        emitted += 1;
      }
    }
  }
  if (summary.failedFiles.length && !grouped.size) {
    lines.push('', `failed files: ${summary.failedFiles.join(', ')}`);
  }
  if (summary.suggestedNextStep) lines.push('', `next: ${summary.suggestedNextStep}`);
  const inline = inlineRawLines(raw);
  if (inline.length) lines.push('', ...inline);
  if (rawHandle) lines.push('', `raw output: use readToolOutput with handle ${rawHandle}`);
  return lines.join('\n');
}
