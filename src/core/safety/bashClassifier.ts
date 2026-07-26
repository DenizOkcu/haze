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
type ResolveContext = {lower: string; complex: boolean};
type Resolved = Pick<BashClassification, 'riskLevel' | 'reason' | 'confidence'>;
/**
 * A trait that the rule contributes to the classification when it matches.
 * Omitting `pattern` marks the trait as unconditional for that rule.
 */
type TraitSpec = {trait: BashTrait; pattern?: RegExp};
/**
 * A rule matches when its trigger fires. Most rules test against the
 * lowercased command; the writes rule also checks the original-case command so
 * camelCase filesystem API names (e.g. `writeFileSync`) still match.
 */
type TriggerFn = (trimmed: string, lower: string) => boolean;
/**
 * Table-driven classifier rule. Rules are evaluated in order; the first rule
 * whose trigger matches wins. Precedence mirrors the original top-down
 * branches: destructive > find-delete/find-exec > network/install > writes >
 * validation > read-only, which keeps classification stable while collapsing
 * the return paths into a single one.
 */
type ClassifierRule = {
  trigger: TriggerFn;
  traits: TraitSpec[];
  resolve: (ctx: ResolveContext) => Resolved;
};
const DESTRUCTIVE_TRIGGER =
  /(^|[;&|]\s*)(rm\b|rm\s+-|git\s+reset\s+--hard\b|git\s+clean\b|git\s+restore\s+\.|git\s+checkout\s+--(?:\b|\s|$))|push\b.*--force|drop\s+database|truncate\s+table/;
const NETWORK_TRIGGER =
  /(^|[;&|]\s*)(curl\b|wget\b|scp\b|ssh\b|npm\s+(install|i|add)\b|pnpm\s+(install|add)\b|yarn\s+(add|install)\b|pip\s+install\b|brew\s+install\b)/;
const WRITES_REDIRECT = /(^|\s)(>|>>)(\s|\S)/;
const WRITES_MUTATING_VERBS =
  /(^|[;&|]\s*)(sed\s+-i|perl\s+-pi|tee\b|chmod\b|mv\b|cp\b|mkdir\b|touch\b|git\s+(add|commit|merge|rebase|checkout|restore)\b)/;
const WRITES_FS_API = /\b(File\.write|writeFileSync|writeFile|appendFileSync|appendFile)\b/;
const VALIDATION_TRIGGER =
  /(^|[;&|]\s*)(npm\s+test|npm\s+run\s+(test|typecheck|lint|build)|pnpm\s+(test|run\s+(test|typecheck|lint|build))|yarn\s+(test|run\s+(test|typecheck|lint|build))|vitest\b|jest\b|tsc\b|eslint\b)/;
const READ_TRIGGER =
  /(^|[;&|]\s*)(git\s+(status|diff|log|show|branch)\b|rg\b|grep\b|find\b|ls\b|pwd\b|cat\b|head\b|tail\b|node\s+--version|npm\s+--version|which\b)/;
const COMPLEX_TRIGGER = /[`$()]|\b(eval|xargs|sh\s+-c|bash\s+-c)\b/;
const EXEC_DESTRUCTIVE_PAYLOAD = /\brm\b|git\s+clean|git\s+restore|drop\s+database|truncate\s+table/;
const EXEC_MUTATING_PAYLOAD = /\b(chmod|mv|cp|mkdir|touch|tee|sed\s+-i|perl\s+-pi)\b|git\s+(add|commit|merge|rebase|checkout|restore)/;
const onLower = (pattern: RegExp): TriggerFn => (_trimmed, lower) => pattern.test(lower);
const RULES: ClassifierRule[] = [
  {
    trigger: onLower(DESTRUCTIVE_TRIGGER),
    traits: [
      {trait: 'deletes_files', pattern: /\brm\b|git\s+clean|git\s+restore|git\s+checkout\s+--|drop\s+database|truncate\s+table/},
      {trait: 'changes_git_state', pattern: /\bgit\b/},
    ],
    resolve: ({complex}) => ({
      riskLevel: 'destructive',
      reason: 'command can delete files or irreversibly change repository state',
      confidence: complex ? 'medium' : 'high',
    }),
  },
  // `find -delete` removes matched files outright. `-delete` is a find-specific
  // primary, so gate on `find` to avoid flagging unrelated single-dash flags.
  {
    trigger: (_trimmed, lower) => /\bfind\b/.test(lower) && /(\s|^)-delete\b/.test(lower),
    traits: [{trait: 'deletes_files'}],
    resolve: ({complex}) => ({
      riskLevel: 'destructive',
      reason: 'find -delete removes matched files',
      confidence: complex ? 'medium' : 'high',
    }),
  },
  // `find -exec`/`-execdir` and `xargs` run an embedded command. Classify by
  // the payload so destructive/mutating verbs are not masked by the read-only
  // `find`/`xargs` wrapper, and never promise read-only for an arbitrary exec.
  {
    trigger: (_trimmed, lower) => /(?:\s|^)(?:-exec(?:dir)?|xargs)\s/.test(lower),
    traits: [
      {trait: 'deletes_files', pattern: EXEC_DESTRUCTIVE_PAYLOAD},
      {trait: 'changes_git_state', pattern: /\bgit\b/},
      {trait: 'changes_permissions', pattern: /\bchmod\b/},
      {trait: 'writes_files', pattern: EXEC_MUTATING_PAYLOAD},
      {trait: 'reads_files'},
    ],
    resolve: ({lower}) => {
      const execMatch = /(?:\s|^)(?:-exec(?:dir)?|xargs)\s+(.*)$/.exec(lower);
      const payload = execMatch ? execMatch[1] : lower;
      if (EXEC_DESTRUCTIVE_PAYLOAD.test(payload)) {
        return {riskLevel: 'destructive', reason: 'embedded command can delete files', confidence: 'medium'};
      }
      if (EXEC_MUTATING_PAYLOAD.test(payload)) {
        return {riskLevel: 'mutating', reason: 'embedded command can modify files', confidence: 'medium'};
      }
      return {riskLevel: 'unknown', reason: 'find -exec / xargs runs an embedded command', confidence: 'low'};
    },
  },
  {
    trigger: onLower(NETWORK_TRIGGER),
    traits: [
      {trait: 'uses_network'},
      {trait: 'installs_dependencies', pattern: /\b(npm|pnpm|yarn|pip|brew)\b/},
      {trait: 'writes_files', pattern: /\b(npm|pnpm|yarn|pip|brew)\b/},
    ],
    resolve: ({lower, complex}) => ({
      riskLevel: /\b(curl|wget|scp|ssh)\b/.test(lower) && !/\binstall|\badd\b/.test(lower) ? 'network' : 'mutating',
      reason: 'command uses the network or installs dependencies',
      confidence: complex ? 'medium' : 'high',
    }),
  },
  {
    trigger: (trimmed, lower) =>
      WRITES_REDIRECT.test(trimmed) || WRITES_MUTATING_VERBS.test(lower) || WRITES_FS_API.test(trimmed),
    traits: [
      {trait: 'writes_files'},
      {trait: 'changes_permissions', pattern: /\bchmod\b/},
      {trait: 'changes_git_state', pattern: /\bgit\b/},
    ],
    resolve: ({complex}) => ({
      riskLevel: 'mutating',
      reason: 'command can modify files or repository state',
      confidence: complex ? 'medium' : 'high',
    }),
  },
  {
    trigger: onLower(VALIDATION_TRIGGER),
    traits: [
      {trait: 'runs_tests', pattern: /test|vitest|jest/},
      {trait: 'runs_build', pattern: /build|tsc|typecheck|lint|eslint/},
    ],
    resolve: ({complex}) => ({
      riskLevel: 'read_only',
      reason: 'validation command',
      confidence: complex ? 'medium' : 'high',
    }),
  },
  {
    trigger: onLower(READ_TRIGGER),
    traits: [{trait: 'reads_files'}],
    resolve: ({complex}) =>
      complex
        ? {riskLevel: 'unknown', reason: 'read-like command with complex shell syntax', confidence: 'low'}
        : {riskLevel: 'read_only', reason: 'read-only inspection command', confidence: 'high'},
  },
];

function collectTraits(rule: ClassifierRule, lower: string): BashTrait[] {
  const traits: BashTrait[] = [];
  for (const spec of rule.traits) {
    if (spec.pattern === undefined || spec.pattern.test(lower)) traits.push(spec.trait);
  }
  return traits;
}

function uniq<T>(values: T[]) {
  return [...new Set(values)];
}

export function classifyBashCommand(command: string): BashClassification {
  const trimmed = command.trim();
  if (!trimmed) {
    return {riskLevel: 'unknown', traits: [], confidence: 'high', reason: 'empty command'};
  }

  const lower = trimmed.toLowerCase();
  const complex = COMPLEX_TRIGGER.test(trimmed);

  for (const rule of RULES) {
    if (!rule.trigger(trimmed, lower)) continue;
    const {riskLevel, reason, confidence} = rule.resolve({lower, complex});
    return {riskLevel, traits: uniq(collectTraits(rule, lower)), confidence, reason};
  }

  return {riskLevel: 'unknown', traits: [], confidence: 'low', reason: 'command did not match known safe patterns'};
}

export function isValidationClassification(classification: BashClassification) {
  return classification.traits.includes('runs_tests') || classification.traits.includes('runs_build');
}
