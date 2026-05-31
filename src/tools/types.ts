export interface ToolContext {
  cwd: string;
  skillDir: string;
}

export interface ToolResult {
  ok: boolean;
  message?: string;
  data?: unknown;
}
