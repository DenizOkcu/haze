import type {HazeSettings} from '../../config/settings.js';
import {readUsageEntries} from './usageLedger.js';

export interface BudgetWarning {
  key: string;
  message: string;
}

export interface BudgetCheckInput {
  settings: HazeSettings;
  sessionCost?: number;
  baseDir?: string;
}

function thresholdKey(scope: string, level: number) {
  return `${scope}:${level}`;
}

export async function checkBudget(input: BudgetCheckInput): Promise<BudgetWarning | undefined> {
  const budget = input.settings.budget;
  if (!budget || budget.enabled === false) return undefined;

  if (budget.session != null && budget.session > 0 && input.sessionCost != null) {
    const cost = input.sessionCost;
    if (cost >= budget.session * 0.8) {
      const level = Math.floor(cost / (budget.session * 0.8));
      return {
        key: thresholdKey('session', level),
        message: `Session spend estimate ~$${cost.toFixed(4)} (${Math.round((cost / budget.session) * 100)}% of $${budget.session} budget).`,
      };
    }
  }

  if (budget.daily != null && budget.daily > 0) {
    const today = await readUsageEntries({baseDir: input.baseDir});
    const cost = today.reduce((sum, entry) => sum + (entry.cost ?? 0), 0);
    const hasPrice = today.some(entry => entry.cost != null);
    if (hasPrice && cost >= budget.daily * 0.8) {
      const level = Math.floor(cost / (budget.daily * 0.8));
      return {
        key: thresholdKey('daily', level),
        message: `Daily spend estimate ~$${cost.toFixed(4)} (${Math.round((cost / budget.daily) * 100)}% of $${budget.daily} budget).`,
      };
    }
  }

  return undefined;
}
