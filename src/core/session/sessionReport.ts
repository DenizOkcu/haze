import type {SessionEntry} from './sessionStore.js';

export interface SessionReport {
  sessionId?: string;
  version?: string;
  model?: string;
  models: string[];
  reasoning?: string;
  contextWindowTokens?: number;
  peakInputTokens: number;
  steps: number;
  toolCalls: Record<string, number>;
  failedToolCalls: number;
  failedValidations: Record<string, number>;
  continuations: number;
  compactions: number;
  budgetBoundaries: number;
  goals: Array<{id: string; intent: string; cycles: number; status: string; validation: string; openTasks: number; mutations: number; stopReason?: string; gateDecision?: string; openCheckCount: number; evidenceMismatch?: boolean}>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Summarize a session without copying prompts, commands, paths, or tool output. */
export function summarizeSessionEntries(entries: readonly SessionEntry[]): SessionReport {
  const report: SessionReport = {
    models: [], peakInputTokens: 0, steps: 0, toolCalls: {}, failedToolCalls: 0,
    failedValidations: {}, continuations: 0, compactions: 0, budgetBoundaries: 0, goals: [],
  };
  const goals = new Map<string, SessionReport['goals'][number]>();
  const finalEvidence = new Map<string, Record<string, unknown>>();
  const hasCompactEntries = entries.some(entry => entry.type === 'compact');
  for (const entry of entries) {
    if (entry.type === 'header') {
      report.sessionId = entry.id;
      report.version = entry.hazeVersion;
    } else if (entry.type === 'compact') {
      report.compactions++;
    } else if (entry.type === 'goal') {
      let goal = goals.get(entry.goalId);
      if (!goal) {
        goal = {id: entry.goalId, intent: entry.intent, cycles: 0, status: 'active', validation: 'not_applicable', openTasks: 0, mutations: 0, openCheckCount: 0};
        goals.set(entry.goalId, goal);
        report.goals.push(goal);
      }
      goal.cycles = Math.max(goal.cycles, entry.cycle);
      goal.validation = entry.validationOutcome;
      goal.mutations = entry.mutationCount;
      goal.openTasks = (entry.taskCounts?.pending ?? 0) + (entry.taskCounts?.inProgress ?? 0);
      goal.openCheckCount = entry.failedCheckIds?.length ?? 0;
      if (entry.phase === 'goal_end') {
        goal.status = entry.status ?? 'unknown';
        goal.stopReason = entry.stopReason;
        goal.gateDecision = entry.gateDecision;
      }
    } else if (entry.type === 'event' && entry.text) {
      let event: Record<string, unknown> | undefined;
      try { event = record(JSON.parse(entry.text) as unknown); } catch { continue; }
      if (!event) continue;
      if (entry.name === 'step_end') {
        report.steps++;
        if (typeof event.responseModel === 'string') {
          report.model = event.responseModel;
          if (!report.models.includes(event.responseModel)) report.models.push(event.responseModel);
        }
        const usage = record(event.usage);
        if (typeof usage?.inputTokens === 'number') report.peakInputTokens = Math.max(report.peakInputTokens, usage.inputTokens);
      } else if (entry.name === 'tool_end') {
        const name = typeof event.name === 'string' ? event.name : 'unknown';
        report.toolCalls[name] = (report.toolCalls[name] ?? 0) + 1;
        if (event.success === false) report.failedToolCalls++;
        const summary = record(event.validation) ?? record(record(event.output)?.validationSummary);
        if (summary?.status === 'failed') {
          const kind = typeof summary.kind === 'string' ? summary.kind : 'generic';
          report.failedValidations[kind] = (report.failedValidations[kind] ?? 0) + 1;
        }
      } else if (entry.name === 'goal_continue') {
        report.continuations++;
      } else if (entry.name === 'turn_end' && record(event.evidence)?.budgetBoundary === true) {
        report.budgetBoundaries++;
      } else if (entry.name === 'goal_end' && typeof event.goalId === 'string') {
        const evidence = record(event.evidence);
        if (evidence) finalEvidence.set(event.goalId, evidence);
      } else if (entry.name === 'reasoning_policy' && typeof event.effective === 'string') {
        report.reasoning = event.effective;
      } else if (entry.name === 'context_budget' && typeof event.contextWindowTokens === 'number') {
        report.contextWindowTokens = event.contextWindowTokens;
      } else if (!hasCompactEntries && entry.name === 'compaction_end' && event.compacted === true) {
        report.compactions++;
      }
    }
  }
  for (const goal of report.goals) {
    const evidence = finalEvidence.get(goal.id);
    if (!evidence) continue;
    const tasks = record(evidence.taskProgress);
    const eventOpenTasks = (typeof tasks?.pending === 'number' ? tasks.pending : 0) + (typeof tasks?.inProgress === 'number' ? tasks.inProgress : 0);
    if (evidence.validationOutcome !== goal.validation || evidence.mutationCount !== goal.mutations || eventOpenTasks !== goal.openTasks) goal.evidenceMismatch = true;
  }
  return report;
}

export function formatSessionReport(report: SessionReport, parseErrors = 0): string {
  const toolLines = Object.entries(report.toolCalls).sort((a, b) => b[1] - a[1]).map(([name, count]) => `  ${name}: ${count}`);
  const goalLines = report.goals.map(goal => `  ${goal.id}: ${goal.status}${goal.stopReason ? ` (${goal.stopReason})` : ''} · ${goal.intent} · ${goal.cycles} cycle(s) · gate ${goal.gateDecision ?? 'unknown'} · validation ${goal.validation} · ${goal.openTasks} open task(s) · ${goal.openCheckCount} open check(s)${goal.evidenceMismatch ? ' · terminal evidence mismatch' : ''}`);
  return [
    `Session ${report.sessionId ?? 'unknown'}${report.version ? ` · Haze ${report.version}` : ''}`,
    `Models: ${report.models.join(' → ') || report.model || 'unknown'}${report.reasoning ? ` · reasoning ${report.reasoning}` : ''}${report.contextWindowTokens ? ` · context ${report.contextWindowTokens}` : ''}`,
    `Steps: ${report.steps} · peak input: ${report.peakInputTokens} tokens · continuations: ${report.continuations} · budget boundaries: ${report.budgetBoundaries} · compactions: ${report.compactions}`,
    `Tool failures: ${report.failedToolCalls} · failed validations: ${Object.entries(report.failedValidations).map(([kind, count]) => `${kind} ${count}`).join(', ') || '0'}`,
    ...(parseErrors ? [`Parse errors: ${parseErrors}`] : []),
    'Goals:', ...goalLines, 'Tool calls:', ...toolLines,
  ].join('\n');
}
