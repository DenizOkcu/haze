export type CheckSeverity = 'critical' | 'warning' | 'info' | 'ok';

export interface CheckResult {
  name: string;
  severity: CheckSeverity;
  message: string;
  hint?: string;
  fixable?: boolean;
}
