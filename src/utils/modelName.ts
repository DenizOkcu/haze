export function shortModelName(modelName: string | undefined) {
  const trimmed = modelName?.trim();
  if (!trimmed) return 'model';
  const slashShort = trimmed.split('/').filter(Boolean).at(-1) ?? trimmed;
  const colonShort = slashShort.split(':').filter(Boolean).at(-1) ?? slashShort;
  return colonShort.length > 32 ? `${colonShort.slice(0, 29)}…` : colonShort;
}

export function modelThinkingLabel(modelName: string | undefined) {
  return `${shortModelName(modelName)} is thinking`;
}
