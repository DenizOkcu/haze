export interface AgentPlanStep {
  description: string;
  tool?: string;
  input?: Record<string, unknown>;
}

export interface AgentPlan {
  summary: string;
  requiresTools: boolean;
  needsApproval: boolean;
  steps: AgentPlanStep[];
}

export interface AgentResult {
  plan: AgentPlan;
  toolResults: unknown[];
  summary: string;
}
