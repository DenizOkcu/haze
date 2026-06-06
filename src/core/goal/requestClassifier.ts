export type RequestIntent = 'implement' | 'fix' | 'test' | 'review' | 'plan' | 'answer' | 'unknown';

export function isPlanOnlyRequest(value: string) {
  return /\b(create|make|write|draft|outline)\s+(?:a\s+)?plan\b|\bplan\s+(?:for|to)\b/i.test(value) && !/\bimplement|execute|do\b/i.test(value);
}

export function isPlanImplementationRequest(value: string) {
  return /\b(implement|execute|do)\b.*\bplan\b|\bplan\.md\b|\btest_plan\.md\b/i.test(value);
}

export function isValidationRequest(value: string) {
  if (isPlanOnlyRequest(value)) return false;
  return /\b(run|verify|test|tests|check|validate)\b/i.test(value);
}

export function isActionRequest(value: string) {
  if (isPlanOnlyRequest(value)) return false;
  return /\b(add|create|write|implement|update|fix|change|support|wire|test|tests|document|docs|documentation|run|verify)\b/i.test(value);
}

export function classifyRequestIntent(value: string): RequestIntent {
  if (isPlanOnlyRequest(value)) return 'plan';
  if (/\b(review|audit|inspect|analy[sz]e|compare)\b/i.test(value)) return 'review';
  if (/\b(fix|repair|resolve|debug)\b/i.test(value)) return 'fix';
  if (/\b(run|verify|check|validate)\b/i.test(value) || /\btests?\b/i.test(value) && !/\b(add|create|write)\b/i.test(value)) return 'test';
  if (/\b(add|create|write|implement|update|change|support|wire|document|docs|documentation)\b/i.test(value)) return 'implement';
  if (/\b(what|why|how|explain|tell me)\b/i.test(value)) return 'answer';
  return 'unknown';
}
