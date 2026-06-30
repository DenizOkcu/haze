import type {CommandContext, CommandResult} from './commands.js';
import type {CheckResult, CheckSeverity} from '../doctor/types.js';
import {
  checkActiveModel,
  checkContextFiles,
  checkHazeDirWritable,
  checkLspServers,
  checkMcpServers,
  checkNodeVersion,
  checkProviderReachable,
  checkProvidersConfigured,
  checkRipgrepAvailable,
  checkSettingsValid,
  checkSkillsValid,
} from '../doctor/checks.js';

function iconForSeverity(severity: CheckSeverity): string {
  switch (severity) {
    case 'critical':
      return '❌';
    case 'warning':
      return '⚠️';
    case 'info':
      return 'ℹ️';
    case 'ok':
      return '✅';
  }
}

function severityRank(severity: CheckSeverity): number {
  switch (severity) {
    case 'critical':
      return 0;
    case 'warning':
      return 1;
    case 'info':
      return 2;
    case 'ok':
      return 3;
  }
}

export function formatDoctorReport(results: CheckResult[]): string {
  const ordered = [...results].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const criticals = ordered.filter(r => r.severity === 'critical').length;
  const warnings = ordered.filter(r => r.severity === 'warning').length;
  const lines: string[] = [];
  lines.push(`Doctor report: ${criticals} critical, ${warnings} warning, ${ordered.length} total`);
  lines.push('');
  for (const result of ordered) {
    lines.push(`${iconForSeverity(result.severity)} ${result.name}: ${result.message}`);
    if (result.hint) lines.push(`   💡 ${result.hint}`);
  }
  return lines.join('\n');
}

export async function runDoctorChecks(
  settings: CommandContext['settings'],
  options: {full?: boolean} = {},
): Promise<CheckResult[]> {
  return await Promise.all([
    checkSettingsValid(),
    checkProvidersConfigured(settings),
    checkActiveModel(settings),
    checkNodeVersion(),
    checkRipgrepAvailable(),
    checkHazeDirWritable(),
    checkSkillsValid(),
    checkContextFiles(),
    checkLspServers(settings),
    checkMcpServers(settings),
    ...(options.full ? [checkProviderReachable(settings)] : []),
  ]);
}

export async function handleDoctorCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  const full = args.trim() === '--full';
  const results = await runDoctorChecks(ctx.settings, {full});
  ctx.addSystemMessage(formatDoctorReport(results));
  return 'handled';
}
