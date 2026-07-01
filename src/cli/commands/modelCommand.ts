import {activeProvider, configuredProviders, modelSelector, resolveModelSelector, upsertProvider, type ModelSlotName} from '../../config/providers.js';
import type {CommandContext, CommandResult} from './commands.js';

const SLOT_NAMES: ModelSlotName[] = ['primary', 'lightweight', 'fallback'];

function parseModelCommandArgs(value: string): {slot: ModelSlotName; selector: string} | undefined {
  const args = value.slice('/model '.length).trim();
  const parts = args.split(/\s+/);
  if (SLOT_NAMES.includes(parts[0] as ModelSlotName)) {
    if (parts.length < 2) return undefined;
    return {slot: parts[0] as ModelSlotName, selector: parts.slice(1).join(' ')};
  }
  return {slot: 'primary', selector: args};
}

export async function handleModelCommand(value: string, ctx: CommandContext): Promise<CommandResult | undefined> {
  if (value === '/model') {
    ctx.setModelProviderFilter?.(undefined);
    ctx.setMode('model');
    ctx.addSystemMessage('Choose a model. Selecting a model also sets its provider.');
    return 'handled';
  }
  if (value === '/model list') {
    const providers = configuredProviders(ctx.settings);
    ctx.addSystemMessage(['Configured models:', ...providers.flatMap(provider => provider.models.map(model => `- ${modelSelector(provider, model)} - ${provider.name}`))].join('\n'));
    return 'handled';
  }
  if (!value.startsWith('/model ')) return undefined;

  const parsed = parseModelCommandArgs(value);
  if (!parsed) {
    ctx.addSystemMessage('Provide a model selector, e.g. /model lightweight openai:gpt-4o-mini.');
    return 'handled';
  }
  const {slot, selector} = parsed;
  const resolved = resolveModelSelector(ctx.settings, selector);
  if (resolved.status === 'ambiguous') {
    ctx.addSystemMessage(`Model ${resolved.model} exists on multiple providers: ${resolved.providers.map(provider => modelSelector(provider, resolved.model)).join(', ')}`);
    return 'handled';
  }
  if (resolved.status === 'missing') {
    if (slot !== 'primary') {
      ctx.addSystemMessage(`Model ${selector} not found. Add it to a provider first with /provider.`);
      return 'handled';
    }
    const provider = activeProvider(ctx.settings);
    if (!provider) {
      ctx.addSystemMessage('No provider configured. Run /provider to choose or add a provider before setting a model.');
      return 'handled';
    }
    const nextProvider = provider.models.includes(selector) ? provider : {...provider, models: [...provider.models, selector]};
    await ctx.updateSettings({provider: provider.name, model: selector, providers: upsertProvider(ctx.settings, nextProvider), models: {...ctx.settings.models, primary: modelSelector(provider, selector)}});
    ctx.addSystemMessage(`Model set to ${selector} on ${provider.name}. Saved to ~/.haze/settings.json.`);
    return 'handled';
  }
  const selectorString = modelSelector(resolved.provider, resolved.model);
  if (slot === 'primary') {
    await ctx.updateSettings({provider: resolved.provider.name, model: resolved.model, models: {...ctx.settings.models, primary: selectorString}});
  } else {
    await ctx.updateSettings({models: {...ctx.settings.models, [slot]: selectorString}});
  }
  ctx.addSystemMessage(`Model set to ${resolved.model} on ${resolved.provider.name} (${slot} slot). Saved to ~/.haze/settings.json.`);
  return 'handled';
}
