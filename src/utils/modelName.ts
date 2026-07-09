export function shortModelName(modelName: string | undefined) {
  const trimmed = modelName?.trim();
  if (!trimmed) return 'model';
  const slashIndex = trimmed.indexOf('/');
  const colonIndex = trimmed.indexOf(':');
  const selectorShort = colonIndex >= 0 && (slashIndex < 0 || colonIndex < slashIndex)
    ? trimmed.slice(colonIndex + 1)
    : trimmed;
  const slashShort = selectorShort.split('/').filter(Boolean).at(-1) ?? selectorShort;
  return slashShort.length > 32 ? `${slashShort.slice(0, 29)}…` : slashShort;
}

export function modelThinkingLabel(modelName: string | undefined) {
  return `${shortModelName(modelName)} is thinking`;
}
