export type SkillCreationResult = {
  busy?: boolean;
  busyLabel?: string;
  message?: string;
  description?: string;
  draftName?: string;
  mode?: 'chat';
  clearDraft?: boolean;
};

export function captureSkillDescription(value: string, draftName: string | undefined): SkillCreationResult {
  const description = value.trim();
  if (!description) return {message: 'Description is required. Try again, or press ESC to cancel.'};
  if (!draftName) return {mode: 'chat', clearDraft: true, message: 'Skill wizard lost the name. Start over with /skills.'};
  return {description, draftName, busy: true, busyLabel: 'Creating skill'};
}

export function skillCreationMessage(name: string, file: string): string {
  return `Created skill ${name} at ${file}. Invoke it with /${name}. Edit SKILL.md to refine its workflow.`;
}

export function skillCreationFailure(error: unknown): string {
  return `Skill creation failed: ${error instanceof Error ? error.message : String(error)}`;
}