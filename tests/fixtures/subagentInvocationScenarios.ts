export type ExpectedInvocation = 'direct' | 'one-worker' | 'multiple-workers';

export const subagentInvocationScenarios: ReadonlyArray<{name: string; request: string; expected: ExpectedInvocation; reason: string}> = [
  {name: 'targeted-read', request: 'Read one known 80-line file and answer one question.', expected: 'direct', reason: 'handoff overhead exceeds exploration'},
  {name: 'large-log', request: 'Diagnose a 20k-line log and return root cause evidence.', expected: 'one-worker', reason: 'large private context, compact result'},
  {name: 'external-api', request: 'Research one external API across several docs.', expected: 'one-worker', reason: 'fetched docs stay private'},
  {name: 'multi-axis-audit', request: 'Audit auth, persistence, and fetch independently.', expected: 'multiple-workers', reason: 'independent noisy axes'},
  {name: 'sequential-refactor', request: 'Rename a symbol then update dependent callers.', expected: 'direct', reason: 'sequential dependency'},
  {name: 'product-decision', request: 'Ask the user to choose product behavior.', expected: 'direct', reason: 'requires interaction'},
  {name: 'shared-config', request: 'Have two tasks edit the same shared config.', expected: 'direct', reason: 'shared mutation'},
  {name: 'validation-diagnosis', request: 'Run broad tests and isolate failure evidence.', expected: 'one-worker', reason: 'noisy validation'},
  {name: 'known-edit', request: 'Apply a known two-line edit.', expected: 'direct', reason: 'trivial bounded work'},
];
