export type BashRiskLevel = 'read_only' | 'mutating' | 'destructive' | 'network' | 'unknown';

export type BashTrait =
  | 'reads_files'
  | 'writes_files'
  | 'deletes_files'
  | 'installs_dependencies'
  | 'runs_tests'
  | 'runs_build'
  | 'uses_network'
  | 'changes_git_state'
  | 'changes_permissions';

export type BashClassification = {
  riskLevel: BashRiskLevel;
  traits: BashTrait[];
  confidence: 'high' | 'medium' | 'low';
  reason: string;
};

function has(command: string, pattern: RegExp) {
  return pattern.test(command);
}

function uniq<T>(values: T[]) {
  return [...new Set(values)];
}

export function classifyBashCommand(command: string): BashClassification {
  const trimmed = command.trim();
  const traits: BashTrait[] = [];
  const lower = trimmed.toLowerCase();
  const complex = /[`$()]|\b(eval|xargs|sh\s+-c|bash\s+-c)\b/.test(trimmed);

  if (!trimmed) {
    return {riskLevel: 'unknown', traits: [], confidence: 'high', reason: 'empty command'};
  }

  if (has(lower, /(^|[;&|]\s*)(rm\b|rm\s+-|git\s+reset\s+--hard\b|git\s+clean\b|git\s+restore\s+\.|git\s+checkout\s+--\b)/) || has(lower, /push\b.*--force|drop\s+database|truncate\s+table/)) {
    if (has(lower, /\brm\b|git\s+clean|git\s+restore|git\s+checkout\s+--|drop\s+database|truncate\s+table/)) traits.push('deletes_files');
    if (has(lower, /\bgit\b/)) traits.push('changes_git_state');
    return {riskLevel: 'destructive', traits: uniq(traits), confidence: complex ? 'medium' : 'high', reason: 'command can delete files or irreversibly change repository state'};
  }

  if (has(lower, /(^|[;&|]\s*)(curl\b|wget\b|scp\b|ssh\b|npm\s+(install|i|add)\b|pnpm\s+(install|add)\b|yarn\s+(add|install)\b|pip\s+install\b|brew\s+install\b)/)) {
    traits.push('uses_network');
    if (has(lower, /\b(npm|pnpm|yarn|pip|brew)\b/)) traits.push('installs_dependencies', 'writes_files');
    return {riskLevel: has(lower, /\b(curl|wget|scp|ssh)\b/) && !has(lower, /\binstall|\badd\b/) ? 'network' : 'mutating', traits: uniq(traits), confidence: complex ? 'medium' : 'high', reason: 'command uses the network or installs dependencies'};
  }

  if (has(trimmed, /(^|\s)(>|>>)(\s|\S)/) || has(lower, /(^|[;&|]\s*)(sed\s+-i|perl\s+-pi|tee\b|chmod\b|mv\b|cp\b|mkdir\b|touch\b|git\s+(add|commit|merge|rebase|checkout|restore)\b)/) || has(trimmed, /\b(File\.write|writeFileSync|writeFile|appendFileSync|appendFile)\b/)) {
    traits.push('writes_files');
    if (has(lower, /\bchmod\b/)) traits.push('changes_permissions');
    if (has(lower, /\bgit\b/)) traits.push('changes_git_state');
    return {riskLevel: 'mutating', traits: uniq(traits), confidence: complex ? 'medium' : 'high', reason: 'command can modify files or repository state'};
  }

  // `find -delete` removes matched files outright. `-delete` is a find-specific
  // primary, so gate on `find` to avoid flagging unrelated single-dash flags.
  if (has(lower, /\bfind\b/) && has(lower, /(\s|^)-delete\b/)) {
    traits.push('deletes_files');
    return {riskLevel: 'destructive', traits: uniq(traits), confidence: complex ? 'medium' : 'high', reason: 'find -delete removes matched files'};
  }

  // `find -exec`/`-execdir` and `xargs` run an embedded command. Classify by
  // the payload so destructive/mutating verbs are not masked by the read-only
  // `find`/`xargs` wrapper, and never promise read-only for an arbitrary exec.
  const execMatch = /(?:\s|^)(?:-exec(?:dir)?|xargs)\s+(.*)$/.exec(lower);
  if (execMatch) {
    const payload = execMatch[1];
    if (has(payload, /\brm\b|git\s+clean|git\s+restore|drop\s+database|truncate\s+table/)) {
      if (has(payload, /\brm\b/)) traits.push('deletes_files');
      if (has(payload, /\bgit\b/)) traits.push('changes_git_state');
      return {riskLevel: 'destructive', traits: uniq(traits), confidence: 'medium', reason: 'embedded command can delete files'};
    }
    if (has(payload, /\b(chmod|mv|cp|mkdir|touch|tee|sed\s+-i|perl\s+-pi)\b/) || has(payload, /\bgit\s+(add|commit|merge|rebase|checkout|restore)\b/)) {
      traits.push('writes_files');
      if (has(payload, /\bchmod\b/)) traits.push('changes_permissions');
      if (has(payload, /\bgit\b/)) traits.push('changes_git_state');
      return {riskLevel: 'mutating', traits: uniq(traits), confidence: 'medium', reason: 'embedded command can modify files'};
    }
    traits.push('reads_files');
    return {riskLevel: 'unknown', traits: uniq(traits), confidence: 'low', reason: 'find -exec / xargs runs an embedded command'};
  }

  if (has(lower, /(^|[;&|]\s*)(npm\s+test|npm\s+run\s+(test|typecheck|lint|build)|pnpm\s+(test|run\s+(test|typecheck|lint|build))|yarn\s+(test|run\s+(test|typecheck|lint|build))|vitest\b|jest\b|tsc\b|eslint\b)/)) {
    if (has(lower, /test|vitest|jest/)) traits.push('runs_tests');
    if (has(lower, /build|tsc|typecheck|lint|eslint/)) traits.push('runs_build');
    return {riskLevel: 'read_only', traits: uniq(traits), confidence: complex ? 'medium' : 'high', reason: 'validation command'};
  }

  if (has(lower, /(^|[;&|]\s*)(git\s+(status|diff|log|show|branch)\b|rg\b|grep\b|find\b|ls\b|pwd\b|cat\b|head\b|tail\b|node\s+--version|npm\s+--version|which\b)/)) {
    traits.push('reads_files');
    return {riskLevel: complex ? 'unknown' : 'read_only', traits: uniq(traits), confidence: complex ? 'low' : 'high', reason: complex ? 'read-like command with complex shell syntax' : 'read-only inspection command'};
  }

  // GitHub CLI read-only subcommands
  if (has(lower, /\bgh\b/)) {
    // Explicitly reject known mutating subcommands before trusting anything else.
    const mutating = [
      ['pr', 'merge'],
      ['pr', 'create'],
      ['pr', 'edit'],
      ['pr', 'close'],
      ['pr', 'reopen'],
      ['pr', 'review'],
      ['issue', 'create'],
      ['issue', 'edit'],
      ['issue', 'close'],
      ['issue', 'reopen'],
      ['run', 'rerun'],
      ['run', 'watch'],
      ['run', 'cancel'],
      ['release', 'create'],
      ['release', 'edit'],
      ['release', 'delete'],
      ['repo', 'create'],
      ['repo', 'fork'],
      ['repo', 'delete'],
      ['gist', 'create'],
      ['gist', 'edit'],
      ['gist', 'delete'],
    ];
    if (mutating.some(([tool, verb]) => has(lower, new RegExp(`\\b${tool}\\s+${verb}\\b`)))) {
      return {riskLevel: 'unknown', traits: [], confidence: 'low', reason: 'mutating gh subcommand'};
    }

    // gh api is ambiguous unless it is explicitly GET or has no method.
    if (has(lower, /\bapi\b/)) {
      if (/\s(-X|--method)\s+(POST|PATCH|PUT|DELETE)\b/i.test(lower)) {
        return {riskLevel: 'unknown', traits: [], confidence: 'low', reason: 'mutating gh api method'};
      }
      traits.push('reads_files');
      return {riskLevel: 'read_only', traits: uniq(traits), confidence: complex ? 'medium' : 'high', reason: 'read-only gh api call'};
    }

    const readOnlySubcommands = [
      ['pr', 'list'],
      ['pr', 'view'],
      ['pr', 'diff'],
      ['pr', 'status'],
      ['pr', 'checks'],
      ['pr', 'comment'],
      ['issue', 'list'],
      ['issue', 'view'],
      ['issue', 'comment'],
      ['run', 'list'],
      ['run', 'view'],
      ['repo', 'view'],
      ['repo', 'list'],
      ['gist', 'list'],
      ['gist', 'view'],
    ];
    if (readOnlySubcommands.some(([tool, verb]) => has(lower, new RegExp(`\\b${tool}\\s+${verb}\\b`)))) {
      traits.push('reads_files');
      return {riskLevel: 'read_only', traits: uniq(traits), confidence: complex ? 'medium' : 'high', reason: 'read-only gh subcommand'};
    }
  }

  return {riskLevel: 'unknown', traits: [], confidence: 'low', reason: 'command did not match known safe patterns'};
}

export function isValidationClassification(classification: BashClassification) {
  return classification.traits.includes('runs_tests') || classification.traits.includes('runs_build');
}
