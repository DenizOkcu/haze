import type {BashClassification} from '../safety/bashClassifier.js';
import type {ValidationKind, ValidationSummary} from '../../llm/toolResultTypes.js';

function uniq(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function inferKind(command: string, classification?: BashClassification): ValidationKind {
  const lower = command.toLowerCase();
  if (/typecheck|\btsc\b|\bmypy\b/.test(lower)) return 'typecheck';
  if (/\beslint\b|\blint\b|\bclippy\b|\bgo\s+vet\b|\bpylint\b|\bruff\s+(check|format\s+--check)\b|\bcargo\s+check\b/.test(lower)) return 'lint';
  if (/\bbuild\b/.test(lower) || classification?.traits.includes('runs_build')) return 'build';
  if (/\b(test|vitest|jest|pytest|unittest)\b/.test(lower) || classification?.traits.includes('runs_tests')) return 'test';
  return 'generic';
}

export function parseValidationOutput(input: {
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  classification?: BashClassification;
}): ValidationSummary {
  const text = `${input.stdout}\n${input.stderr}`;
  const lines = text.split(/\r?\n/);
  const diagnostics: ValidationSummary['diagnostics'] = [];
  const failedTests: string[] = [];
  const failedFiles: string[] = [];
  const kind = inferKind(input.command, input.classification);

  let cargoErrorMessage: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    const ts = line.match(/^(.+?\.(?:ts|tsx|js|jsx|mts|cts))\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/);
    if (ts) {
      const [, file, lineNo, column, severity, message] = ts;
      diagnostics.push({file, line: Number(lineNo), column: Number(column), severity: severity === 'warning' ? 'warning' : 'error', message: message ?? ''});
      failedFiles.push(file ?? '');
      continue;
    }
    const eslint = line.match(/^(.+?\.(?:ts|tsx|js|jsx|mts|cts))\s*$/);
    if (eslint) {
      const currentFile = eslint[1] ?? '';
      const next = lines[i + 1];
      if (next && /^\s*\d+:\d+\s+/.test(next)) failedFiles.push(currentFile);
    }
    const eslintDiag = line.match(/^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}\S+)?$/);
    if (eslintDiag) {
      const [, lineNo, column, severity, message] = eslintDiag;
      diagnostics.push({line: Number(lineNo), column: Number(column), severity: severity === 'warning' ? 'warning' : 'error', message: message ?? ''});
      continue;
    }
    const vitestFile = line.match(/^\s*(?:FAIL|FAILED|✓|✗|❯)?\s*([^\s]+\.(?:test|spec)\.(?:ts|tsx|js|jsx))/i);
    if (vitestFile) failedFiles.push(vitestFile[1] ?? '');
    const testName = line.match(/^\s*(?:FAIL|✗|×|●)\s+(.+)$/);
    if (testName && !/^(FAIL|FAILED)\s+\S+\.(?:test|spec)\./i.test(line.trim())) failedTests.push((testName[1] ?? '').trim());
    const genericFile = line.match(/([^\s()]+\.(?:ts|tsx|js|jsx|mts|cts)):(\d+):(\d+)/);
    if (genericFile) {
      const [, file, lineNo, column] = genericFile;
      failedFiles.push(file ?? '');
      diagnostics.push({file, line: Number(lineNo), column: Number(column), severity: /warn/i.test(line) ? 'warning' : 'error', message: line.trim()});
    }

    // Rust cargo test
    const cargoTest = line.match(/^\s*test\s+(\S+?)\s+\.\.\.\s+FAILED$/);
    if (cargoTest) {
      failedTests.push(cargoTest[1] ?? '');
      continue;
    }
    if (/^\s*test result: FAILED\b/i.test(line)) {
      continue;
    }

    // Rust cargo check/clippy diagnostics
    const cargoError = line.match(/^\s*error\[E(\d+)\]:\s*(.*)$/);
    if (cargoError) {
      cargoErrorMessage = cargoError[2] ?? 'rustc error';
      continue;
    }
    if (cargoErrorMessage) {
      const loc = line.match(/^\s*-->\s+(.+?):(\d+):(\d+)\s*$/);
      if (loc) {
        const [, file, lineNo, column] = loc;
        diagnostics.push({file, line: Number(lineNo), column: Number(column), severity: 'error', message: cargoErrorMessage});
        failedFiles.push(file ?? '');
        cargoErrorMessage = undefined;
        continue;
      }
      if (!line.trim() || /^\s*error\[E\d+\]:/.test(line)) {
        cargoErrorMessage = undefined;
      }
    }
  }

  const uniqueFiles = uniq(failedFiles).slice(0, 10);
  const uniqueTests = uniq(failedTests).slice(0, 10);
  const diagCount = diagnostics.length;
  const rawOutputTruncated = Boolean(input.stdoutTruncated || input.stderrTruncated);
  // Pipes (e.g. `npm test | tail`) and process substitutions can mask a
  // non-zero exit code behind the final command in the pipeline. Treat
  // parsed failure evidence as authoritative over `code` so a green exit
  // status does not override real failures the parser already found.
  const hasFailureEvidence = uniqueTests.length > 0 || diagCount > 0;
  const status: ValidationSummary['status'] = input.timedOut
    ? 'timed_out'
    : hasFailureEvidence
      ? 'failed'
      : input.code === 0
        ? 'passed'
        : input.code == null
          ? 'unknown'
          : 'failed';
  let summaryText: string;
  if (status === 'passed') summaryText = `${kind} passed`;
  else if (status === 'timed_out') summaryText = `${kind} timed out`;
  else if (uniqueTests.length > 0) summaryText = `${kind} failed: ${uniqueTests.length} failed test${uniqueTests.length === 1 ? '' : 's'}${uniqueFiles.length ? ` in ${uniqueFiles.join(', ')}` : ''}`;
  else if (diagCount > 0) summaryText = `${kind} failed: ${diagCount} diagnostic${diagCount === 1 ? '' : 's'}${uniqueFiles.length ? ` in ${uniqueFiles.join(', ')}` : ''}`;
  else summaryText = `${kind} ${status}`;

  const suggestedNextStep = status === 'failed'
    ? uniqueFiles.length > 0
      ? `Inspect ${uniqueFiles.slice(0, 3).join(', ')} and fix the first relevant failure.`
      : 'Inspect the command output and fix the first relevant failure.'
    : undefined;

  return {kind, status, failedFiles: uniqueFiles, failedTests: uniqueTests, diagnostics: diagnostics.slice(0, 20), summaryText, suggestedNextStep, rawOutputTruncated};
}
