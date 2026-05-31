export interface ToolContext {
  cwd: string;
  skillDir: string;
  config?: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  message?: string;
  data?: unknown;
}
