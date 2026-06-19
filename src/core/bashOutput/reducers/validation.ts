import type {ValidationSummary} from '../../../llm/toolResultTypes.js';

function groupDiagnostics(summary: ValidationSummary) {
  const grouped = new Map<string, ValidationSummary['diagnostics']>();
  for (const diagnostic of summary.diagnostics) {
    const key = diagnostic.file ?? '(unknown file)';
    grouped.set(key, [...(grouped.get(key) ?? []), diagnostic]);
  }
  return grouped;
}

export function renderValidationReduction(summary: ValidationSummary, rawHandle?: string) {
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
  if (rawHandle) lines.push('', `raw output: use readToolOutput with handle ${rawHandle}`);
  return lines.join('\n');
}
